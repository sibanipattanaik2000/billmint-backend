import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { calculateInvoiceTotals } from "../utils/money";

type TransactionClient = Prisma.TransactionClient;

export interface PurchaseItemInput {
  itemId?: string | null;
  itemName: string;
  hsnSac?: string | null;
  quantity: number;
  unit?: string | null;
  rate: number;
  discountPercent?: number;
  gstRate?: number;
}

export interface CreatePurchaseInput {
  supplierId?: string | null;
  billNumber: string;
  date?: Date;
  dueDate?: Date | null;
  placeOfSupply?: string | null;
  items: PurchaseItemInput[];
  paymentMethod?: string | null;
  paidAmount?: number;
  notes?: string | null;
  status?: "DRAFT" | "UNPAID" | "PARTIALLY_PAID" | "PAID";
  createdById?: string | null;
}

interface CalculatedLine {
  itemId: string | null;
  itemName: string;
  hsnSac: string | null;
  quantity: number;
  unit: string | null;
  rate: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  gstRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  amount: number;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveNumber(value: unknown, field: string): number {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new AppError(`${field} must be greater than 0`, 400);
  }

  return number;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new AppError(`${field} cannot be negative`, 400);
  }

  return number;
}

async function getNextBillNumber(
  businessId: string,
  tx: TransactionClient,
): Promise<string> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      prefix: string;
      nextNumber: number;
    }>
  >`
    SELECT
      "id",
      "prefix",
      "nextNumber"
    FROM "invoice_sequences"
    WHERE
      "businessId" = ${businessId}::uuid
      AND "type" = 'purchase'
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new AppError(
      "Purchase invoice sequence is not configured for this business",
      500,
    );
  }

  const sequence = rows[0];

  const number = Number(sequence.nextNumber);

  if (!Number.isInteger(number) || number < 1) {
    throw new AppError(
      "Invalid purchase invoice sequence",
      500,
    );
  }

  await tx.invoiceSequence.update({
    where: {
      id: sequence.id,
    },
    data: {
      nextNumber: number + 1,
    },
  });

  return `${sequence.prefix}${String(number).padStart(4, "0")}`;
}

async function validateSupplier(
  businessId: string,
  supplierId: string | null | undefined,
  tx: TransactionClient,
) {
  if (!supplierId) return null;

  const supplier = await tx.supplier.findFirst({
    where: {
      id: supplierId,
      businessId,
      deletedAt: null,
      status: "ACTIVE",
    },
  });

  if (!supplier) {
    throw new AppError(
      "Supplier not found or inactive",
      404,
    );
  }

  return supplier;
}

async function calculateLines(
  businessId: string,
  items: PurchaseItemInput[],
  isInterState: boolean,
  tx: TransactionClient,
): Promise<CalculatedLine[]> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(
      "At least one purchase item is required",
      400,
    );
  }

  if (items.length > 100) {
    throw new AppError(
      "A purchase cannot contain more than 100 items",
      400,
    );
  }

  const itemIds = [
    ...new Set(
      items
        .map((item) => cleanString(item.itemId))
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const dbItems =
    itemIds.length > 0
      ? await tx.item.findMany({
          where: {
            id: {
              in: itemIds,
            },
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: {
            id: true,
            name: true,
            hsnSac: true,
            unit: {
              select: {
                shortName: true,
              },
            },
            gstRate: true,
          },
        })
      : [];

  const itemMap = new Map(
    dbItems.map((item) => [item.id, item]),
  );

  const lines: CalculatedLine[] = [];

  for (let index = 0; index < items.length; index++) {
    const input = items[index];

    const itemId = cleanString(input.itemId);

    const dbItem = itemId
      ? itemMap.get(itemId)
      : undefined;

    if (itemId && !dbItem) {
      throw new AppError(
        `Item at position ${index + 1} was not found or is inactive`,
        404,
      );
    }

    const itemName =
      cleanString(input.itemName) ||
      dbItem?.name ||
      null;

    if (!itemName) {
      throw new AppError(
        `Item name is required at position ${index + 1}`,
        400,
      );
    }

    const quantity = positiveNumber(
      input.quantity,
      `Quantity for ${itemName}`,
    );

    const rate = nonNegativeNumber(
      input.rate,
      `Rate for ${itemName}`,
    );

    const discountPercent = nonNegativeNumber(
      input.discountPercent ?? 0,
      `Discount for ${itemName}`,
    );

    if (discountPercent > 100) {
      throw new AppError(
        `Discount for ${itemName} cannot exceed 100%`,
        400,
      );
    }

    const gstRate =
      input.gstRate !== undefined &&
      input.gstRate !== null
        ? nonNegativeNumber(
            input.gstRate,
            `GST rate for ${itemName}`,
          )
        : Number(dbItem?.gstRate ?? 0);

    if (gstRate > 100) {
      throw new AppError(
        `GST rate for ${itemName} cannot exceed 100%`,
        400,
      );
    }

    const grossAmount = quantity * rate;

    const discountAmount =
      grossAmount * (discountPercent / 100);

    const taxableAmount =
      grossAmount - discountAmount;

    const gstAmount =
      taxableAmount * (gstRate / 100);

    const cgstAmount = isInterState
      ? 0
      : gstAmount / 2;

    const sgstAmount = isInterState
      ? 0
      : gstAmount / 2;

    const igstAmount = isInterState
      ? gstAmount
      : 0;

    const amount = taxableAmount + gstAmount;

    lines.push({
      itemId,
      itemName,
      hsnSac:
        cleanString(input.hsnSac) ??
        dbItem?.hsnSac ??
        null,
      quantity,
      unit:
        cleanString(input.unit) ??
        dbItem?.unit?.shortName ??
        null,
      rate,
      discountPercent,
      discountAmount,
      taxableAmount,
      gstRate,
      cgstAmount,
      sgstAmount,
      igstAmount,
      amount,
    });
  }

  return lines;
}

export async function createPurchase(
  businessId: string,
  input: CreatePurchaseInput,
) {
  const billNumber = cleanString(input.billNumber);

  if (!billNumber) {
    throw new AppError(
      "Bill number is required",
      400,
    );
  }

  if (billNumber.length > 100) {
    throw new AppError(
      "Bill number cannot exceed 100 characters",
      400,
    );
  }

  const paymentMethod =
    cleanString(input.paymentMethod);

  const notes = cleanString(input.notes);

  const placeOfSupply =
    cleanString(input.placeOfSupply);

  const requestedPaidAmount = nonNegativeNumber(
    input.paidAmount ?? 0,
    "Paid amount",
  );

  const purchaseDate =
    input.date instanceof Date &&
    !Number.isNaN(input.date.getTime())
      ? input.date
      : new Date();

  const dueDate =
    input.dueDate instanceof Date &&
    !Number.isNaN(input.dueDate.getTime())
      ? input.dueDate
      : null;

  if (dueDate && dueDate < purchaseDate) {
    throw new AppError(
      "Due date cannot be before purchase date",
      400,
    );
  }

  return prisma.$transaction(
    async (tx) => {
      const existingBill =
        await tx.purchase.findFirst({
          where: {
            businessId,
            billNumber,
            deletedAt: null,
          },
          select: {
            id: true,
          },
        });

      if (existingBill) {
        throw new AppError(
          `Purchase bill ${billNumber} already exists`,
          409,
        );
      }

      const supplier = await validateSupplier(
        businessId,
        input.supplierId,
        tx,
      );

      const business =
        await tx.business.findUnique({
          where: {
            id: businessId,
          },
          select: {
            state: true,
          },
        });

      if (!business) {
        throw new AppError(
          "Business not found",
          404,
        );
      }

      const isInterState =
        Boolean(
          supplier?.state &&
            business.state &&
            supplier.state.trim().toLowerCase() !==
              business.state.trim().toLowerCase(),
        );

      const lines = await calculateLines(
        businessId,
        input.items,
        isInterState,
        tx,
      );

      const subtotal = lines.reduce(
        (sum, line) =>
          sum + line.quantity * line.rate,
        0,
      );

      const discountAmount = lines.reduce(
        (sum, line) =>
          sum + line.discountAmount,
        0,
      );

      const taxableAmount = lines.reduce(
        (sum, line) =>
          sum + line.taxableAmount,
        0,
      );

      const cgstAmount = lines.reduce(
        (sum, line) =>
          sum + line.cgstAmount,
        0,
      );

      const sgstAmount = lines.reduce(
        (sum, line) =>
          sum + line.sgstAmount,
        0,
      );

      const igstAmount = lines.reduce(
        (sum, line) =>
          sum + line.igstAmount,
        0,
      );

      const totalBeforeRound =
        taxableAmount +
        cgstAmount +
        sgstAmount +
        igstAmount;

      const grandTotal =
        Math.round(
          totalBeforeRound * 100,
        ) / 100;

      const roundOff =
        Math.round(
          (grandTotal - totalBeforeRound) * 100,
        ) / 100;

      if (requestedPaidAmount > grandTotal) {
        throw new AppError(
          "Paid amount cannot exceed purchase total",
          400,
        );
      }

      const balanceAmount =
        Math.round(
          (grandTotal - requestedPaidAmount) *
            100,
        ) / 100;

      let status:
        | "DRAFT"
        | "UNPAID"
        | "PARTIALLY_PAID"
        | "PAID";

      if (input.status === "DRAFT") {
        status = "DRAFT";
      } else if (grandTotal === 0) {
        status = "PAID";
      } else if (balanceAmount <= 0) {
        status = "PAID";
      } else if (requestedPaidAmount > 0) {
        status = "PARTIALLY_PAID";
      } else {
        status = "UNPAID";
      }

      const generatedBillNumber =
        await getNextBillNumber(
          businessId,
          tx,
        );

      const purchase =
        await tx.purchase.create({
          data: {
            businessId,
            billNumber:
              billNumber || generatedBillNumber,
            supplierId:
              supplier?.id ?? null,
            date: purchaseDate,
            dueDate,
            status,
            placeOfSupply,
            isInterState,
            subtotal,
            discountAmount,
            taxableAmount,
            cgstAmount,
            sgstAmount,
            igstAmount,
            cessAmount: 0,
            roundOff,
            grandTotal,
            paidAmount:
              status === "DRAFT"
                ? 0
                : requestedPaidAmount,
            balanceAmount:
              status === "DRAFT"
                ? grandTotal
                : balanceAmount,
            paymentMethod,
            notes,
            createdById:
              input.createdById ?? null,

            items: {
              create: lines.map((line) => ({
                itemId: line.itemId,
                itemName: line.itemName,
                hsnSac: line.hsnSac,
                quantity: line.quantity,
                unit: line.unit,
                rate: line.rate,
                discountPercent:
                  line.discountPercent,
                discountAmount:
                  line.discountAmount,
                taxableAmount:
                  line.taxableAmount,
                gstRate: line.gstRate,
                cgstAmount:
                  line.cgstAmount,
                sgstAmount:
                  line.sgstAmount,
                igstAmount:
                  line.igstAmount,
                amount: line.amount,
              })),
            },
          },
          include: {
            supplier: true,
            items: true,
          },
        });

      /*
       * Stock and supplier balances are updated only
       * for non-draft purchases.
       */
      if (status !== "DRAFT") {
        for (const line of lines) {
          if (!line.itemId) continue;

          const updatedItem =
            await tx.item.update({
              where: {
                id: line.itemId,
              },
              data: {
                currentStock: {
                  increment: line.quantity,
                },
              },
              select: {
                currentStock: true,
              },
            });

          await tx.stockMovement.create({
            data: {
              businessId,
              itemId: line.itemId,
              date: purchaseDate,
              type: "PURCHASE",
              quantityIn: line.quantity,
              quantityOut: 0,
              balance:
                updatedItem.currentStock,
              referenceType: "PURCHASE",
              referenceId: purchase.id,
              notes: `Purchase ${purchase.billNumber}`,
            },
          });
        }

        if (supplier && balanceAmount > 0) {
          await tx.supplier.update({
            where: {
              id: supplier.id,
            },
            data: {
              currentBalance: {
                increment: balanceAmount,
              },
            },
          });
        }

        if (
          requestedPaidAmount > 0 &&
          supplier
        ) {
          const payment =
            await tx.paymentOut.create({
              data: {
                businessId,
                supplierId: supplier.id,
                amount: requestedPaidAmount,
                date: purchaseDate,
                paymentMethod:
                  paymentMethod || "cash",
                createdById:
                  input.createdById ?? null,
                notes: `Payment for purchase ${purchase.billNumber}`,
              },
            });

          await tx.paymentOutAllocation.create({
            data: {
              paymentOutId: payment.id,
              purchaseId: purchase.id,
              amount: requestedPaidAmount,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId:
            input.createdById ?? null,
          action: "CREATE",
          module: "purchases",
          recordId: purchase.id,
          recordName: purchase.billNumber,
        },
      });

      return purchase;
    },
    {
      isolationLevel:
        Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}

export async function getPurchases(
  businessId: string,
  opts: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    from?: Date;
    to?: Date;
  } = {},
) {
  const page = Math.max(
    1,
    Number(opts.page) || 1,
  );

  const limit = Math.min(
    100,
    Math.max(
      1,
      Number(opts.limit) || 20,
    ),
  );

  const skip = (page - 1) * limit;

  const where: Prisma.PurchaseWhereInput = {
    businessId,
    deletedAt: null,
  };

  if (opts.status) {
    where.status = opts.status as any;
  }

  if (opts.from || opts.to) {
    where.date = {
      ...(opts.from
        ? { gte: opts.from }
        : {}),
      ...(opts.to
        ? { lte: opts.to }
        : {}),
    };
  }

  if (opts.search?.trim()) {
    const search =
      opts.search.trim();

    where.OR = [
      {
        billNumber: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        supplier: {
          name: {
            contains: search,
            mode: "insensitive",
          },
        },
      },
      {
        supplier: {
          businessName: {
            contains: search,
            mode: "insensitive",
          },
        },
      },
    ];
  }

  const [data, total] =
    await Promise.all([
      prisma.purchase.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              businessName: true,
              phone: true,
            },
          },
          items: true,
        },
        orderBy: [
          {
            date: "desc",
          },
          {
            id: "desc",
          },
        ],
        skip,
        take: limit,
      }),

      prisma.purchase.count({
        where,
      }),
    ]);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages:
        Math.ceil(total / limit),
    },
  };
}

export async function getPurchaseById(
  businessId: string,
  id: string,
) {
  const purchase =
    await prisma.purchase.findFirst({
      where: {
        id,
        businessId,
        deletedAt: null,
      },
      include: {
        supplier: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: {
          include: {
            paymentOut: true,
          },
        },
      },
    });

  if (!purchase) {
    throw new AppError(
      "Purchase not found",
      404,
    );
  }

  return purchase;
}

export async function cancelPurchase(
  businessId: string,
  id: string,
  userId?: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const purchase =
        await tx.purchase.findFirst({
          where: {
            id,
            businessId,
            deletedAt: null,
          },
          include: {
            items: true,
          },
        });

      if (!purchase) {
        throw new AppError(
          "Purchase not found",
          404,
        );
      }

      if (purchase.status === "CANCELLED") {
        throw new AppError(
          "Purchase is already cancelled",
          409,
        );
      }

      if (purchase.status === "DRAFT") {
        await tx.purchase.update({
          where: {
            id: purchase.id,
          },
          data: {
            status: "CANCELLED",
          },
        });
      } else {
        for (const line of purchase.items) {
          if (!line.itemId) continue;

          const updatedItem =
            await tx.item.update({
              where: {
                id: line.itemId,
              },
              data: {
                currentStock: {
                  decrement:
                    line.quantity,
                },
              },
              select: {
                currentStock: true,
              },
            });

          if (
            Number(updatedItem.currentStock) <
            0
          ) {
            throw new AppError(
              `Cannot cancel purchase because stock for ${line.itemName} would become negative`,
              409,
            );
          }

          await tx.stockMovement.create({
            data: {
              businessId,
              itemId: line.itemId,
              date: new Date(),
              type: "PURCHASE_RETURN",
              quantityIn: 0,
              quantityOut:
                line.quantity,
              balance:
                updatedItem.currentStock,
              referenceType:
                "PURCHASE_CANCEL",
              referenceId:
                purchase.id,
              notes: `Cancelled purchase ${purchase.billNumber}`,
            },
          });
        }

        if (
          purchase.supplierId &&
          Number(purchase.balanceAmount) > 0
        ) {
          await tx.supplier.update({
            where: {
              id: purchase.supplierId,
            },
            data: {
              currentBalance: {
                decrement:
                  purchase.balanceAmount,
              },
            },
          });
        }

        await tx.purchase.update({
          where: {
            id: purchase.id,
          },
          data: {
            status: "CANCELLED",
          },
        });
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId: userId ?? null,
          action: "CANCEL",
          module: "purchases",
          recordId: purchase.id,
          recordName:
            purchase.billNumber,
        },
      });

      return {
        message:
          "Purchase cancelled successfully",
      };
    },
    {
      isolationLevel:
        Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}