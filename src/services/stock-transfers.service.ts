
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../utils/money";

type TransferLine = {
  itemId: string;
  quantity: number;
};

type TransferInput = {
  toStoreCode: string;
  items: TransferLine[];
  notes?: string | null;
};

export async function createStockTransfer(
  fromBusinessId: string,
  input: TransferInput,
  userId?: string,
) {
  const toStoreCode = input.toStoreCode.trim().toUpperCase();

  if (!toStoreCode) {
    throw new AppError("Destination Store Code is required", 400);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("Add at least one item to transfer", 400);
  }

  if (input.items.length > 100) {
    throw new AppError("A transfer cannot contain more than 100 lines", 400);
  }

  return prisma.$transaction(
    async (tx) => {
      const destination = await tx.business.findFirst({
        where: {
          storeCode: toStoreCode,
          deletedAt: null,
        },
        select: {
          id: true,
          storeCode: true,
          name: true,
        },
      });

      if (!destination) {
        throw new AppError("Destination store was not found", 404);
      }

      if (destination.id === fromBusinessId) {
        throw new AppError("Cannot transfer stock to the same store", 400);
      }

      const sourceBusiness = await tx.business.findFirst({
        where: {
          id: fromBusinessId,
          deletedAt: null,
        },
        select: {
          id: true,
          storeCode: true,
          name: true,
        },
      });

      if (!sourceBusiness) {
        throw new AppError("Source store was not found", 404);
      }

      const transferNumber =
        `TRF-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

      const transfer = await tx.stockTransfer.create({
        data: {
          fromBusinessId,
          toBusinessId: destination.id,
          transferNumber,
          status: "COMPLETED",
          notes: input.notes?.trim() || null,
          createdById: userId || null,
        },
      });

      const results = [];

      for (const line of input.items) {
        const itemId = String(line.itemId || "").trim();
        const quantity = toDecimal(line.quantity);

        if (!itemId || !quantity.isFinite() || !quantity.gt(0)) {
          throw new AppError("Each transfer line needs an item and positive quantity", 400);
        }

        const sourceItem = await tx.item.findFirst({
          where: {
            id: itemId,
            businessId: fromBusinessId,
            deletedAt: null,
            status: "ACTIVE",
          },
        });

        if (!sourceItem) {
          throw new AppError(`Source item ${itemId} was not found in your store`, 404);
        }

        if (sourceItem.trackSerial) {
          throw new AppError(
            `Serialized item "${sourceItem.name}" needs the IMEI-aware transfer workflow. It has not been moved.`,
            400,
          );
        }

        const deducted = await tx.item.updateMany({
          where: {
            id: sourceItem.id,
            businessId: fromBusinessId,
            deletedAt: null,
            status: "ACTIVE",
            currentStock: { gte: quantity as any },
          },
          data: {
            currentStock: { decrement: quantity as any },
          },
        });

        if (deducted.count !== 1) {
          throw new AppError(
            `Insufficient or changed stock for "${sourceItem.name}". No transfer was committed.`,
            409,
          );
        }

        // Match by SKU when available. Otherwise, match by exact name and model.
        let destinationItem = sourceItem.sku
          ? await tx.item.findFirst({
              where: {
                businessId: destination.id,
                sku: sourceItem.sku,
                deletedAt: null,
                status: "ACTIVE",
              },
            })
          : await tx.item.findFirst({
              where: {
                businessId: destination.id,
                name: sourceItem.name,
                modelName: sourceItem.modelName,
                deletedAt: null,
                status: "ACTIVE",
                sku: null,
              },
            });

        if (!destinationItem) {
          destinationItem = await tx.item.create({
            data: {
              businessId: destination.id,
              name: sourceItem.name,
              modelName: sourceItem.modelName,
              sku: sourceItem.sku,
              barcode: null,
              imei: null,
              deviceCode: null,
              categoryId: null,
              brandId: null,
              unitId: null,
              description: sourceItem.description,
              purchasePrice: sourceItem.purchasePrice,
              salePrice: sourceItem.salePrice,
              mrp: sourceItem.mrp,
              openingStock: 0,
              currentStock: 0,
              minimumStock: sourceItem.minimumStock,
              gstRate: sourceItem.gstRate,
              hsnSac: sourceItem.hsnSac,
              discountPercent: sourceItem.discountPercent,
              supplierId: null,
              trackBatch: sourceItem.trackBatch,
              trackSerial: false,
              trackExpiry: sourceItem.trackExpiry,
              sourceStoreCode:
                sourceItem.sourceStoreCode || sourceBusiness.storeCode,
            },
          });
        }

        if (destinationItem.trackSerial) {
          throw new AppError(
            `Destination item "${destinationItem.name}" uses serial tracking. Transfer cancelled.`,
            400,
          );
        }

        await tx.item.update({
          where: { id: destinationItem.id },
          data: {
            currentStock: { increment: quantity as any },
          },
        });

        const sourceAfter = await tx.item.findUniqueOrThrow({
          where: { id: sourceItem.id },
          select: { currentStock: true },
        });

        const destinationAfter = await tx.item.findUniqueOrThrow({
          where: { id: destinationItem.id },
          select: { currentStock: true },
        });

        await tx.stockMovement.createMany({
          data: [
            {
              businessId: fromBusinessId,
              itemId: sourceItem.id,
              type: "TRANSFER",
              quantityIn: toDecimal(0) as any,
              quantityOut: quantity as any,
              balance: sourceAfter.currentStock as any,
              referenceType: "stock_transfer",
              referenceId: transfer.id,
              notes: `Transfer ${transferNumber} to ${destination.storeCode}`,
            },
            {
              businessId: destination.id,
              itemId: destinationItem.id,
              type: "TRANSFER",
              quantityIn: quantity as any,
              quantityOut: toDecimal(0) as any,
              balance: destinationAfter.currentStock as any,
              referenceType: "stock_transfer",
              referenceId: transfer.id,
              notes: `Transfer ${transferNumber} from ${sourceBusiness.storeCode}`,
            },
          ],
        });

        await tx.stockTransferItem.create({
          data: {
            transferId: transfer.id,
            sourceItemId: sourceItem.id,
            destinationItemId: destinationItem.id,
            quantity: quantity as any,
            inventoryUnitIds: [],
          },
        });

        results.push({
          itemName: sourceItem.name,
          quantity: quantity.toString(),
          sourceItemId: sourceItem.id,
          destinationItemId: destinationItem.id,
        });
      }

      await tx.auditLog.createMany({
        data: [
          {
            businessId: fromBusinessId,
            userId: userId || null,
            action: "TRANSFER_OUT",
            module: "inventory",
            recordId: transfer.id,
            recordName: transferNumber,
            details: JSON.stringify({
              destinationStoreCode: destination.storeCode,
              items: results,
            }),
          },
          {
            businessId: destination.id,
            userId: userId || null,
            action: "TRANSFER_IN",
            module: "inventory",
            recordId: transfer.id,
            recordName: transferNumber,
            details: JSON.stringify({
              sourceStoreCode: sourceBusiness.storeCode,
              items: results,
            }),
          },
        ],
      });

      return {
        id: transfer.id,
        transferNumber,
        status: transfer.status,
        fromStore: sourceBusiness,
        toStore: destination,
        items: results,
        createdAt: transfer.createdAt,
      };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10000,
      timeout: 20000,
    },
  );
}

export async function listStockTransfers(businessId: string) {
  return prisma.stockTransfer.findMany({
    where: {
      OR: [
        { fromBusinessId: businessId },
        { toBusinessId: businessId },
      ],
    },
    include: {
      fromBusiness: {
        select: { name: true, storeCode: true },
      },
      toBusiness: {
        select: { name: true, storeCode: true },
      },
      items: {
        include: {
          sourceItem: {
            select: { id: true, name: true, sku: true, modelName: true },
          },
          destinationItem: {
            select: { id: true, name: true, sku: true, modelName: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
