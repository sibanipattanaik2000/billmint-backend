import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { roundMoney, toDecimal } from "../utils/money";

type TransactionClient = Prisma.TransactionClient;

export interface PurchaseReturnItemInput {
  itemId?: string | null;
  itemName: string;
  quantity: number;
  rate: number;
  taxAmount?: number;
}

export interface CreatePurchaseReturnInput {
  purchaseId?: string | null;
  supplierId?: string | null;
  date?: Date;
  notes?: string | null;
  items: PurchaseReturnItemInput[];
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}

function validateAmount(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(`${field} must be a valid non-negative amount`, 400);
  }
  return value;
}

async function generateReturnNumber(
  businessId: string,
  tx: TransactionClient,
): Promise<string> {
  const settings = await tx.businessSettings.findUnique({
    where: { businessId },
    select: { id: true },
  });

  if (!settings) {
    throw new AppError("Business settings not found", 500);
  }

  // Purchase-return numbering has no dedicated counter in the
  // current schema. Use a collision-resistant reference.
  return `PR-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function createPurchaseReturn(
  businessId: string,
  input: CreatePurchaseReturnInput,
) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("At least one return item is required", 400);
  }

  if (input.items.length > 100) {
    throw new AppError("A return cannot contain more than 100 items", 400);
  }

  const date =
    input.date instanceof Date && !Number.isNaN(input.date.getTime())
      ? input.date
      : new Date();

  return prisma.$transaction(
    async (tx) => {
      const business = await tx.business.findFirst({
        where: { id: businessId, deletedAt: null },
        select: { id: true },
      });

      if (!business) {
        throw new AppError("Business not found", 404);
      }

      const purchaseId = cleanString(input.purchaseId);
      const supplierId = cleanString(input.supplierId);

      const purchase = purchaseId
        ? await tx.purchase.findFirst({
            where: {
              id: purchaseId,
              businessId,
              deletedAt: null,
            },
            include: { items: true },
          })
        : null;

      if (purchaseId && !purchase) {
        throw new AppError("Original purchase not found", 404);
      }
      if (purchase && ["DRAFT", "CANCELLED"].includes(purchase.status)) {
        throw new AppError(
          "Cannot return items against a draft or cancelled purchase",
          400,
        );
      }
      if (purchase && supplierId && purchase.supplierId !== supplierId) {
        throw new AppError(
          "Supplier does not match the original purchase",
          400,
        );
      }

      const resolvedSupplierId = supplierId ?? purchase?.supplierId ?? null;

      if (resolvedSupplierId) {
        const supplier = await tx.supplier.findFirst({
          where: {
            id: resolvedSupplierId,
            businessId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (!supplier) {
          throw new AppError("Supplier not found", 404);
        }
      }

      const itemIds = [
        ...new Set(
          input.items
            .map((line) => cleanString(line.itemId))
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      const dbItems = itemIds.length
        ? await tx.item.findMany({
            where: {
              id: { in: itemIds },
              businessId,
              deletedAt: null,
            },
            select: {
              id: true,
              name: true,
              currentStock: true,
              trackSerial: true,
            },
          })
        : [];

      const itemMap = new Map(dbItems.map((item) => [item.id, item]));

      for (const itemId of itemIds) {
        if (!itemMap.has(itemId)) {
          throw new AppError(
            "A return item was not found in this business",
            404,
          );
        }
      }

      const requestedByItem = new Map<string, number>();

      for (const line of input.items) {
        if (!cleanString(line.itemName)) {
          throw new AppError("Return item name is required", 400);
        }

        if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
          throw new AppError("Return quantity must be greater than zero", 400);
        }

        validateAmount(line.rate, "Return rate");
        validateAmount(line.taxAmount ?? 0, "Return tax");

        const itemId = cleanString(line.itemId);

        if (itemId) {
          requestedByItem.set(
            itemId,
            (requestedByItem.get(itemId) ?? 0) + line.quantity,
          );
        }
      }

      if (purchase) {
        for (const line of input.items) {
          const itemId = cleanString(line.itemId);

          if (!itemId) {
            throw new AppError(
              "Item ID is required for returns linked to a purchase",
              400,
            );
          }

          if (!purchase.items.some((sold) => sold.itemId === itemId)) {
            throw new AppError(
              `Item "${line.itemName}" was not included in the original purchase`,
              400,
            );
          }
        }

        for (const [itemId, requestedQty] of requestedByItem) {
          const purchasedQty = purchase.items
            .filter((line) => line.itemId === itemId)
            .reduce((sum, line) => sum + Number(line.quantity), 0);

          const previousReturns = await tx.purchaseReturnItem.findMany({
            where: {
              itemId,
              purchaseReturn: {
                businessId,
                purchaseId: purchase.id,
              },
            },
            select: { quantity: true },
          });

          const alreadyReturned = previousReturns.reduce(
            (sum, line) => sum + Number(line.quantity),
            0,
          );

          if (alreadyReturned + requestedQty > purchasedQty + 0.000001) {
            throw new AppError(
              `Return quantity exceeds the remaining purchased quantity for "${
                itemMap.get(itemId)?.name ?? itemId
              }"`,
              400,
            );
          }
        }
      }

      // Do not let the user return more physical stock than is currently
      // available. Serialized inventory requires an explicit unit workflow.
      for (const [itemId, quantity] of requestedByItem) {
        const item = itemMap.get(itemId)!;

        if (item.trackSerial) {
          throw new AppError(
            `Serialized item "${item.name}" requires the serial-number supplier-return workflow`,
            400,
          );
        }

        if (Number(item.currentStock) + 0.000001 < quantity) {
          throw new AppError(
            `Insufficient stock to return "${item.name}". Available: ${item.currentStock}, requested: ${quantity}`,
            400,
          );
        }
      }

      const lines = input.items.map((line) => {
        const quantity = toDecimal(line.quantity);
        const rate = toDecimal(line.rate);
        const taxAmount = roundMoney(line.taxAmount ?? 0);

        return {
          itemId: cleanString(line.itemId),
          itemName:
            cleanString(line.itemName) ??
            (line.itemId ? itemMap.get(line.itemId)?.name : null) ??
            "Item",
          quantity,
          rate,
          taxAmount,
          amount: roundMoney(quantity.mul(rate).plus(taxAmount)),
        };
      });

      const subtotal = roundMoney(
        lines.reduce(
          (sum, line) => sum.plus(line.quantity.mul(line.rate)),
          toDecimal(0),
        ),
      );

      const taxTotal = roundMoney(
        lines.reduce((sum, line) => sum.plus(line.taxAmount), toDecimal(0)),
      );

      const grandTotal = roundMoney(subtotal.plus(taxTotal));

      const returnNumber = await generateReturnNumber(businessId, tx);

      const created = await tx.purchaseReturn.create({
        data: {
          businessId,
          returnNumber,
          purchaseId: purchase?.id ?? null,
          supplierId: resolvedSupplierId,
          date,
          subtotal,
          taxAmount: taxTotal,
          grandTotal,
          notes: cleanString(input.notes),
          items: {
            create: lines.map((line) => ({
              itemId: line.itemId,
              itemName: line.itemName,
              quantity: line.quantity,
              rate: line.rate,
              taxAmount: line.taxAmount,
              amount: line.amount,
            })),
          },
        },
        include: { items: true },
      });

      if (purchase) {
        const outstanding = Math.max(0, Number(purchase.balanceAmount));
        const returnValue = Number(grandTotal);
        const remainingBalance = Math.max(0, outstanding - returnValue);
        const paidAmount = Number(purchase.paidAmount);

        const nextStatus =
          remainingBalance <= 0
            ? "PAID"
            : paidAmount > 0
              ? "PARTIALLY_PAID"
              : "UNPAID";

        await tx.purchase.update({
          where: {
            id: purchase.id,
          },
          data: {
            balanceAmount: toDecimal(Math.round(remainingBalance * 100) / 100),
            status: nextStatus,
          },
        });
      }
      for (const [itemId, quantity] of requestedByItem) {
        const item = itemMap.get(itemId)!;

        // Conditional decrement prevents a concurrent transaction from
        // reducing stock below zero. Serializable isolation is also enabled.
        const updated = await tx.item.updateMany({
          where: {
            id: itemId,
            businessId,
            currentStock: { gte: toDecimal(quantity) },
          },
          data: {
            currentStock: { decrement: toDecimal(quantity) },
          },
        });

        if (updated.count !== 1) {
          throw new AppError(
            `Stock changed while processing the return for "${item.name}". Please retry`,
            409,
          );
        }

        const freshItem = await tx.item.findFirst({
          where: { id: itemId, businessId },
          select: { currentStock: true },
        });

        if (!freshItem) {
          throw new AppError("Item disappeared during return processing", 409);
        }

        await tx.stockMovement.create({
          data: {
            businessId,
            itemId,
            date,
            type: "PURCHASE_RETURN",
            quantityIn: toDecimal(0),
            quantityOut: toDecimal(quantity),
            balance: freshItem.currentStock,
            referenceType: "PURCHASE_RETURN",
            referenceId: created.id,
            notes: `Stock reduced for purchase return ${returnNumber}`,
          },
        });
      }

      return created;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}

export async function listPurchaseReturns(
  businessId: string,
  page = 1,
  limit = 20,
  search?: string,
) {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const term = cleanString(search);

  const where: Prisma.PurchaseReturnWhereInput = {
    businessId,
    ...(term
      ? {
          OR: [
            { returnNumber: { contains: term, mode: "insensitive" } },
            { notes: { contains: term, mode: "insensitive" } },
            {
              supplier: {
                is: {
                  name: { contains: term, mode: "insensitive" },
                },
              },
            },
          ],
        }
      : {}),
  };

  const [data, total] = await prisma.$transaction([
    prisma.purchaseReturn.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        purchase: { select: { id: true, billNumber: true } },
        items: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.purchaseReturn.count({ where }),
  ]);

  return {
    data,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
}

export async function getPurchaseReturnById(businessId: string, id: string) {
  const result = await prisma.purchaseReturn.findFirst({
    where: { id, businessId },
    include: {
      supplier: true,
      purchase: { select: { id: true, billNumber: true } },
      items: true,
    },
  });

  if (!result) {
    throw new AppError("Purchase return not found", 404);
  }

  return result;
}
