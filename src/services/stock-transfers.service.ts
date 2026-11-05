import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../utils/money";

type TransferLineInput = {
  itemId: string;
  inventoryUnitIds: string[];
};

type TransferInput = {
  toStoreCode: string;
  items: TransferLineInput[];
  notes?: string | null;
};

type ReceiveUnitInput = {
  transferUnitId: string;
  barcode: string;
};

function makeTransferNumber(): string {
  const date = new Date();
  const stamp = date
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);

  const suffix = Math.random()
    .toString(36)
    .slice(2, 7)
    .toUpperCase();

  return `TRF-${stamp}-${suffix}`;
}

async function getOrCreateDestinationItem(
  tx: any,
  destinationBusinessId: string,
  sourceItem: any,
  sourceStoreCode: string,
) {
  let destinationItem = sourceItem.sku
    ? await tx.item.findFirst({
        where: {
          businessId: destinationBusinessId,
          sku: sourceItem.sku,
          deletedAt: null,
        },
      })
    : await tx.item.findFirst({
        where: {
          businessId: destinationBusinessId,
          name: sourceItem.name,
          modelName: sourceItem.modelName,
          sku: null,
          deletedAt: null,
        },
      });

  if (destinationItem) return destinationItem;

  return tx.item.create({
    data: {
      businessId: destinationBusinessId,
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

      // Purchase cost and supplier details stay at the source/central store.
      purchasePrice: 0,
      supplierId: null,

      salePrice: sourceItem.salePrice,
      mrp: sourceItem.mrp,
      openingStock: 0,
      currentStock: 0,
      minimumStock: sourceItem.minimumStock,
      gstRate: sourceItem.gstRate,
      hsnSac: sourceItem.hsnSac,
      discountPercent: sourceItem.discountPercent,
      trackBatch: false,
      trackSerial: true,
      trackExpiry: false,
      sourceStoreCode:
        sourceItem.sourceStoreCode || sourceStoreCode,
    },
  });
}

export async function listTransferableInventoryUnits(
  businessId: string,
) {
  const units = await prisma.inventoryUnit.findMany({
    where: {
      businessId,
      status: "AVAILABLE",
      imei: { not: null },
      item: {
        deletedAt: null,
        status: "ACTIVE",
        trackSerial: true,
      },
    },
    select: {
      id: true,
      itemCode: true,
      imei: true,
      sourceCode: true,
      barcode: true,
      status: true,
      item: {
        select: {
          id: true,
          name: true,
          modelName: true,
          sku: true,
          salePrice: true,
        },
      },
    },
    orderBy: [
      { item: { name: "asc" } },
      { createdAt: "asc" },
    ],
    take: 2000,
  });

  return units;
}

export async function createStockTransfer(
  fromBusinessId: string,
  input: TransferInput,
  userId?: string,
) {
  const toStoreCode = input.toStoreCode.trim().toUpperCase();

  if (!toStoreCode) {
    throw new AppError("Destination store is required", 400);
  }

  if (!userId) {
    throw new AppError("Authenticated user is required", 401);
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("Select at least one device", 400);
  }

  if (input.items.length > 100) {
    throw new AppError("A transfer cannot contain more than 100 product lines", 400);
  }

  const allUnitIds = input.items.flatMap(
    (line) => line.inventoryUnitIds || [],
  );

  if (allUnitIds.length === 0) {
    throw new AppError("Select the physical devices to transfer", 400);
  }

  if (allUnitIds.length > 500) {
    throw new AppError("A single transfer cannot contain more than 500 devices", 400);
  }

  if (new Set(allUnitIds).size !== allUnitIds.length) {
    throw new AppError("A device has been selected more than once", 400);
  }

  for (const line of input.items) {
    if (!line.itemId || !Array.isArray(line.inventoryUnitIds) ||
        line.inventoryUnitIds.length === 0) {
      throw new AppError("Every transfer line must contain a product and its device records", 400);
    }
  }

  return prisma.$transaction(
    async (tx) => {
      const [sourceBusiness, destination] = await Promise.all([
        tx.business.findFirst({
          where: {
            id: fromBusinessId,
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            storeCode: true,
          },
        }),
        tx.business.findFirst({
          where: {
            storeCode: toStoreCode,
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            storeCode: true,
          },
        }),
      ]);

      if (!sourceBusiness) {
        throw new AppError("Source store was not found", 404);
      }

      if (!destination) {
        throw new AppError("Destination store was not found", 404);
      }

      if (sourceBusiness.id === destination.id) {
        throw new AppError("Cannot transfer stock to the same store", 400);
      }

      // Require the acting user to be an active member of both stores.
      const destinationMembership = await tx.businessMember.findFirst({
        where: {
          userId,
          businessId: destination.id,
          status: "ACTIVE",
        },
        select: { id: true },
      });

      if (!destinationMembership) {
        throw new AppError(
          "You do not have access to transfer stock to this store",
          403,
        );
      }

      const transferNumber = makeTransferNumber();

      const transfer = await tx.stockTransfer.create({
        data: {
          fromBusinessId,
          toBusinessId: destination.id,
          transferNumber,
          status: "DISPATCHED",
          notes: input.notes?.trim() || null,
          createdById: userId,
          dispatchedAt: new Date(),
        },
      });

      const resultLines: Array<{
        itemName: string;
        quantity: number;
        sourceItemId: string;
        destinationItemId: string;
        imeis: string[];
      }> = [];

      for (const line of input.items) {
        const sourceItem = await tx.item.findFirst({
          where: {
            id: line.itemId,
            businessId: fromBusinessId,
            deletedAt: null,
            status: "ACTIVE",
          },
        });

        if (!sourceItem) {
          throw new AppError(
            `Product ${line.itemId} was not found in the source store`,
            404,
          );
        }

        if (!sourceItem.trackSerial) {
          throw new AppError(
            `"${sourceItem.name}" is not configured for device-level serial tracking. Transfer it only after its inventory units are properly created.`,
            400,
          );
        }

        const units = await tx.inventoryUnit.findMany({
          where: {
            id: { in: line.inventoryUnitIds },
            businessId: fromBusinessId,
            itemId: sourceItem.id,
            status: "AVAILABLE",
          },
          select: {
            id: true,
            imei: true,
            itemCode: true,
            sourceCode: true,
            purchaseId: true,
            purchaseItemId: true,
          },
        });

        if (units.length !== line.inventoryUnitIds.length) {
          throw new AppError(
            `Some selected devices for "${sourceItem.name}" are no longer available. Refresh stock and try again.`,
            409,
          );
        }

        if (units.some((unit) => !unit.imei)) {
          throw new AppError(
            `Every device in "${sourceItem.name}" must have an IMEI before dispatch`,
            400,
          );
        }

        const destinationItem = await getOrCreateDestinationItem(
          tx,
          destination.id,
          sourceItem,
          sourceBusiness.storeCode,
        );

        // Deduct the source quantity only if it is still available.
        const quantity = toDecimal(units.length);

        const stockDeducted = await tx.item.updateMany({
          where: {
            id: sourceItem.id,
            businessId: fromBusinessId,
            currentStock: { gte: quantity as any },
          },
          data: {
            currentStock: { decrement: quantity as any },
          },
        });

        if (stockDeducted.count !== 1) {
          throw new AppError(
            `Stock quantity changed for "${sourceItem.name}". Refresh and retry.`,
            409,
          );
        }

        // Mark physical units in transit. They remain owned by the source
        // business until the destination confirms receipt.
        const markedInTransit = await tx.inventoryUnit.updateMany({
          where: {
            id: { in: line.inventoryUnitIds },
            businessId: fromBusinessId,
            itemId: sourceItem.id,
            status: "AVAILABLE",
          },
          data: {
            status: "IN_TRANSIT",
          },
        });

        if (markedInTransit.count !== units.length) {
          throw new AppError(
            `One or more devices in "${sourceItem.name}" changed during dispatch. No transfer was committed.`,
            409,
          );
        }

        const transferItem = await tx.stockTransferItem.create({
          data: {
            transferId: transfer.id,
            sourceItemId: sourceItem.id,
            destinationItemId: destinationItem.id,
            quantity,
            inventoryUnitIds: units.map((unit) => unit.id),
          },
        });

        await tx.stockTransferUnit.createMany({
          data: units.map((unit) => ({
            transferItemId: transferItem.id,
            inventoryUnitId: unit.id,
            status: "PENDING",
          })),
        });

        const sourceAfter = await tx.item.findUniqueOrThrow({
          where: { id: sourceItem.id },
          select: { currentStock: true },
        });

        await tx.stockMovement.create({
          data: {
            businessId: fromBusinessId,
            itemId: sourceItem.id,
            type: "TRANSFER",
            quantityIn: toDecimal(0) as any,
            quantityOut: quantity as any,
            balance: sourceAfter.currentStock as any,
            referenceType: "stock_transfer",
            referenceId: transfer.id,
            notes: `Dispatched ${transferNumber} to ${destination.storeCode}`,
          },
        });

        resultLines.push({
          itemName: sourceItem.name,
          quantity: units.length,
          sourceItemId: sourceItem.id,
          destinationItemId: destinationItem.id,
          imeis: units.map((unit) => unit.imei!),
        });
      }

      await tx.auditLog.createMany({
        data: [
          {
            businessId: fromBusinessId,
            userId,
            action: "TRANSFER_DISPATCHED",
            module: "inventory",
            recordId: transfer.id,
            recordName: transferNumber,
            details: JSON.stringify({
              destinationStoreCode: destination.storeCode,
              items: resultLines,
            }),
          },
          {
            businessId: destination.id,
            userId,
            action: "TRANSFER_PENDING_RECEIPT",
            module: "inventory",
            recordId: transfer.id,
            recordName: transferNumber,
            details: JSON.stringify({
              sourceStoreCode: sourceBusiness.storeCode,
              items: resultLines,
            }),
          },
        ],
      });

      return {
        id: transfer.id,
        transferNumber,
        status: transfer.status,
        fromBusiness: sourceBusiness,
        toBusiness: destination,
        items: resultLines,
        createdAt: transfer.createdAt,
        dispatchedAt: transfer.dispatchedAt,
      };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10000,
      timeout: 30000,
    },
  );
}

export async function receiveStockTransfer(
  destinationBusinessId: string,
  transferId: string,
  receivedUnits: ReceiveUnitInput[],
  userId?: string,
) {
  if (!userId) {
    throw new AppError("Authenticated user is required", 401);
  }

  if (!Array.isArray(receivedUnits) || receivedUnits.length === 0) {
    throw new AppError("Enter a barcode for at least one device", 400);
  }

  if (receivedUnits.length > 500) {
    throw new AppError("You can receive a maximum of 500 devices at a time", 400);
  }

  const transferUnitIds = receivedUnits.map((unit) =>
    String(unit.transferUnitId || "").trim(),
  );

  if (transferUnitIds.some((id) => !id) ||
      new Set(transferUnitIds).size !== transferUnitIds.length) {
    throw new AppError("Invalid or duplicate transfer device selection", 400);
  }

  const normalized = receivedUnits.map((unit) => ({
    transferUnitId: String(unit.transferUnitId).trim(),
    barcode: String(unit.barcode || "").trim(),
  }));

  for (const unit of normalized) {
    if (unit.barcode.length < 3 || unit.barcode.length > 100) {
      throw new AppError("Every received device needs a valid barcode (3–100 characters)", 400);
    }
  }

  const barcodes = normalized.map((unit) => unit.barcode);

  if (new Set(barcodes).size !== barcodes.length) {
    throw new AppError("Duplicate barcode entered in this receipt", 409);
  }

  return prisma.$transaction(
    async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: {
          id: transferId,
          toBusinessId: destinationBusinessId,
        },
        include: {
          fromBusiness: {
            select: { id: true, name: true, storeCode: true },
          },
          toBusiness: {
            select: { id: true, name: true, storeCode: true },
          },
          items: {
            include: {
              sourceItem: {
                select: { id: true, name: true },
              },
              destinationItem: {
                select: { id: true, name: true },
              },
              transferUnits: {
                include: {
                  inventoryUnit: {
                    select: {
                      id: true,
                      imei: true,
                      itemCode: true,
                      sourceCode: true,
                      businessId: true,
                      itemId: true,
                      status: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!transfer) {
        throw new AppError("Pending transfer was not found for this store", 404);
      }

      if (
        transfer.status !== "DISPATCHED" &&
        transfer.status !== "PARTIALLY_RECEIVED"
      ) {
        throw new AppError(
          `This transfer cannot be received because its status is ${transfer.status}`,
          409,
        );
      }

      const transferUnitMap = new Map<
        string,
        {
          transferUnit: any;
          transferItem: any;
        }
      >();

      for (const item of transfer.items) {
        for (const transferUnit of item.transferUnits) {
          transferUnitMap.set(transferUnit.id, {
            transferUnit,
            transferItem: item,
          });
        }
      }

      const acceptedByItem = new Map<
        string,
        { count: number; itemName: string }
      >();

      for (const entry of normalized) {
        const match = transferUnitMap.get(entry.transferUnitId);

        if (!match) {
          throw new AppError(
            "A selected device does not belong to this transfer",
            400,
          );
        }

        const { transferUnit, transferItem } = match;

        if (transferUnit.status !== "PENDING") {
          throw new AppError(
            `Device ${transferUnit.inventoryUnit.imei || ""} has already been received`,
            409,
          );
        }

        const unit = transferUnit.inventoryUnit;

        if (
          unit.businessId !== transfer.fromBusinessId ||
          unit.status !== "IN_TRANSIT"
        ) {
          throw new AppError(
            "The physical device is not in the expected in-transit state",
            409,
          );
        }

        const existingBarcode = await tx.inventoryUnit.findFirst({
          where: {
            businessId: destinationBusinessId,
            barcode: entry.barcode,
          },
          select: { id: true },
        });

        if (existingBarcode) {
          throw new AppError(
            `Barcode "${entry.barcode}" is already assigned in this store`,
            409,
          );
        }

        const existingItemCode = unit.itemCode
          ? await tx.inventoryUnit.findFirst({
              where: {
                businessId: destinationBusinessId,
                itemCode: unit.itemCode,
              },
              select: { id: true },
            })
          : null;

        if (existingItemCode) {
          throw new AppError(
            `Device item code "${unit.itemCode}" already exists in the destination store`,
            409,
          );
        }
        const existingImei = unit.imei
          ? await tx.inventoryUnit.findFirst({
              where: {
                businessId: destinationBusinessId,
                imei: unit.imei,
              },
              select: { id: true },
            })
          : null;

        if (existingImei) {
          throw new AppError(
            `IMEI "${unit.imei}" is already registered in the destination store`,
            409,
          );
        }
        const moved = await tx.inventoryUnit.updateMany({
          where: {
            id: unit.id,
            businessId: transfer.fromBusinessId,
            status: "IN_TRANSIT",
          },
          data: {
            businessId: destinationBusinessId,
            itemId: transferItem.destinationItemId,
            status: "AVAILABLE",
            barcode: entry.barcode,
          },
        });

        if (moved.count !== 1) {
          throw new AppError(
            "Device receipt conflicted with another operation. Refresh and retry.",
            409,
          );
        }

        await tx.stockTransferUnit.update({
          where: { id: transferUnit.id },
          data: {
            status: "RECEIVED",
            barcode: entry.barcode,
            receivedAt: new Date(),
            receivedById: userId,
          },
        });

        const current = acceptedByItem.get(transferItem.destinationItemId);

        acceptedByItem.set(transferItem.destinationItemId, {
          count: (current?.count || 0) + 1,
          itemName: transferItem.destinationItem.name,
        });
      }

      for (const [destinationItemId, accepted] of acceptedByItem) {
        await tx.item.update({
          where: { id: destinationItemId },
          data: {
            currentStock: {
              increment: toDecimal(accepted.count) as any,
            },
          },
        });

        const destinationItem = await tx.item.findUniqueOrThrow({
          where: { id: destinationItemId },
          select: {
            currentStock: true,
          },
        });

        await tx.stockMovement.create({
          data: {
            businessId: destinationBusinessId,
            itemId: destinationItemId,
            type: "TRANSFER",
            quantityIn: toDecimal(accepted.count) as any,
            quantityOut: toDecimal(0) as any,
            balance: destinationItem.currentStock as any,
            referenceType: "stock_transfer",
            referenceId: transfer.id,
            notes: `Received ${transfer.transferNumber} from ${transfer.fromBusiness.storeCode}`,
          },
        });
      }

      const pendingCount = await tx.stockTransferUnit.count({
        where: {
          transferItem: {
            transferId: transfer.id,
          },
          status: "PENDING",
        },
      });

      const nextStatus =
        pendingCount === 0 ? "RECEIVED" : "PARTIALLY_RECEIVED";

      await tx.stockTransfer.update({
        where: { id: transfer.id },
        data: {
          status: nextStatus,
          receivedAt: pendingCount === 0 ? new Date() : null,
        },
      });

      await tx.auditLog.create({
        data: {
          businessId: destinationBusinessId,
          userId,
          action: "TRANSFER_DEVICES_RECEIVED",
          module: "inventory",
          recordId: transfer.id,
          recordName: transfer.transferNumber,
          details: JSON.stringify({
            receivedCount: normalized.length,
            pendingCount,
            barcodes: normalized.map((unit) => unit.barcode),
          }),
        },
      });

      return {
        id: transfer.id,
        transferNumber: transfer.transferNumber,
        status: nextStatus,
        receivedCount: normalized.length,
        pendingCount,
      };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 10000,
      timeout: 30000,
    },
  );
}

export async function listStockTransfers(businessId: string) {
  const transfers = await prisma.stockTransfer.findMany({
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
            select: {
              id: true,
              name: true,
              sku: true,
              modelName: true,
            },
          },
          destinationItem: {
            select: {
              id: true,
              name: true,
              sku: true,
              modelName: true,
            },
          },
          transferUnits: {
            select: {
              id: true,
              status: true,
              barcode: true,
              receivedAt: true,
              inventoryUnit: {
                select: {
                  id: true,
                  imei: true,
                  itemCode: true,
                  sourceCode: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return transfers.map((transfer) => ({
    ...transfer,
    isIncoming: transfer.toBusinessId === businessId,
    isOutgoing: transfer.fromBusinessId === businessId,
  }));
}