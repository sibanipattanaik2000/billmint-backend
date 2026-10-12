import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { roundMoney, toDecimal } from "../utils/money";

type TransactionClient = Prisma.TransactionClient;

export interface SaleReturnItemInput {
  itemId?: string | null;
  itemName: string;
  quantity: number;
  rate: number;
  taxAmount?: number;
}

export interface CreateSaleReturnInput {
  saleId?: string | null;
  customerId?: string | null;
  date?: Date;
  notes?: string | null;
  items: SaleReturnItemInput[];
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length ? result : null;
}

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(`${field} must be greater than zero`, 400);
  }
  return value;
}

function nonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(`${field} cannot be negative`, 400);
  }
  return value;
}

async function generateReturnNumber(
  businessId: string,
  tx: TransactionClient,
): Promise<string> {
  // The current BusinessSettings schema has no sale-return prefix
  // or counter. Use a unique reference rather than modifying the
  // existing invoice numbering configuration.
  const settings = await tx.businessSettings.findUnique({
    where: { businessId },
    select: { id: true },
  });

  if (!settings) {
    throw new AppError("Business settings not found", 500);
  }

  return `SR-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createSaleReturn(
  businessId: string,
  input: CreateSaleReturnInput,
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

      const saleId = cleanString(input.saleId);
      const customerId = cleanString(input.customerId);

      const sale = saleId
        ? await tx.sale.findFirst({
            where: {
              id: saleId,
              businessId,
              deletedAt: null,
            },
            include: {
              items: true,
            },
          })
        : null;

      if (saleId && !sale) {
        throw new AppError("Original sale not found", 404);
      }

      if (sale && customerId && sale.customerId !== customerId) {
        throw new AppError(
          "Customer does not match the original sale",
          400,
        );
      }

      const resolvedCustomerId = customerId ?? sale?.customerId ?? null;

      if (resolvedCustomerId) {
        const customer = await tx.customer.findFirst({
          where: {
            id: resolvedCustomerId,
            businessId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (!customer) {
          throw new AppError("Customer not found", 404);
        }
      }

      const itemIds = [
        ...new Set(
          input.items
            .map((item) => cleanString(item.itemId))
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

      // Aggregate duplicate item lines before checking previously
      // returned quantities. This prevents splitting a return across
      // duplicate lines to bypass the quantity limit.
      const requestedByItem = new Map<string, number>();

      for (const line of input.items) {
        const name = cleanString(line.itemName);
        if (!name) {
          throw new AppError("Return item name is required", 400);
        }

        positiveNumber(line.quantity, `Quantity for ${name}`);
        nonNegativeNumber(line.rate, `Rate for ${name}`);
        nonNegativeNumber(line.taxAmount ?? 0, `Tax for ${name}`);

        const itemId = cleanString(line.itemId);
        if (itemId) {
          requestedByItem.set(
            itemId,
            (requestedByItem.get(itemId) ?? 0) + line.quantity,
          );
        }
      }

      if (sale) {
        for (const [itemId, requestedQty] of requestedByItem) {
          const soldQty = sale.items
            .filter((line) => line.itemId === itemId)
            .reduce((sum, line) => sum + Number(line.quantity), 0);

          const priorReturns = await tx.saleReturnItem.findMany({
            where: {
              itemId,
              saleReturn: {
                businessId,
                saleId: sale.id,
              },
            },
            select: { quantity: true },
          });

          const returnedQty = priorReturns.reduce(
            (sum, line) => sum + Number(line.quantity),
            0,
          );

          if (requestedQty + returnedQty > soldQty + 0.000001) {
            throw new AppError(
              `Return quantity exceeds the remaining sold quantity for "${
                itemMap.get(itemId)?.name ?? itemId
              }"`,
              400,
            );
          }
        }

        // A linked return cannot claim items that were not included
        // in the original sale.
        for (const line of input.items) {
          const itemId = cleanString(line.itemId);
          if (!itemId) {
            throw new AppError(
              "Item ID is required when returning items against a sale",
              400,
            );
          }

          if (!sale.items.some((sold) => sold.itemId === itemId)) {
            throw new AppError(
              `Item "${line.itemName}" was not included in the original sale`,
              400,
            );
          }
        }
      }

      const calculatedLines = input.items.map((line) => {
        const quantity = toDecimal(line.quantity);
        const rate = toDecimal(line.rate);
        const taxAmount = roundMoney(line.taxAmount ?? 0);
        const amount = roundMoney(quantity.mul(rate).plus(taxAmount));

        return {
          itemId: cleanString(line.itemId),
          itemName:
            cleanString(line.itemName) ??
            (line.itemId ? itemMap.get(line.itemId)?.name : null) ??
            "Item",
          quantity,
          rate,
          taxAmount,
          amount,
        };
      });

      const subtotal = roundMoney(
        calculatedLines.reduce(
          (sum, line) => sum.plus(line.quantity.mul(line.rate)),
          toDecimal(0),
        ),
      );

      const taxTotal = roundMoney(
        calculatedLines.reduce(
          (sum, line) => sum.plus(line.taxAmount),
          toDecimal(0),
        ),
      );

      const grandTotal = roundMoney(subtotal.plus(taxTotal));
      const returnNumber = await generateReturnNumber(businessId, tx);

      const created = await tx.saleReturn.create({
        data: {
          businessId,
          returnNumber,
          saleId: sale?.id ?? null,
          customerId: resolvedCustomerId,
          date,
          subtotal,
          taxAmount: taxTotal,
          grandTotal,
          notes: cleanString(input.notes),
          items: {
            create: calculatedLines.map((line) => ({
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

      // Update stock and append a movement in the same transaction.
      // Serialized inventory units require a separate unit-level
      // return workflow; do not silently mark them available here.
      for (const [itemId, quantity] of requestedByItem) {
        const item = itemMap.get(itemId)!;

        if (item.trackSerial) {
          throw new AppError(
            `Serialized item "${item.name}" requires the serial-number return workflow`,
            400,
          );
        }

        const updatedItem = await tx.item.update({
          where: { id: itemId },
          data: {
            currentStock: { increment: toDecimal(quantity) },
          },
          select: { currentStock: true },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            itemId,
            type: "SALE_RETURN",
            quantityIn: toDecimal(quantity),
            quantityOut: toDecimal(0),
            balance: updatedItem.currentStock,
            referenceType: "SALE_RETURN",
            referenceId: created.id,
            notes: `Stock restored from sale return ${returnNumber}`,
            date,
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

export async function listSaleReturns(
  businessId: string,
  page = 1,
  limit = 20,
  search?: string,
) {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const term = cleanString(search);

  const where: Prisma.SaleReturnWhereInput = {
    businessId,
    ...(term
      ? {
          OR: [
            { returnNumber: { contains: term, mode: "insensitive" } },
            { notes: { contains: term, mode: "insensitive" } },
            {
              customer: {
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
    prisma.saleReturn.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        sale: { select: { id: true, invoiceNumber: true } },
        items: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.saleReturn.count({ where }),
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

export async function getSaleReturnById(
  businessId: string,
  id: string,
) {
  const result = await prisma.saleReturn.findFirst({
    where: { id, businessId },
    include: {
      customer: true,
      sale: { select: { id: true, invoiceNumber: true } },
      items: true,
    },
  });

  if (!result) {
    throw new AppError("Sale return not found", 404);
  }

  return result;
}