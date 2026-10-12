import { Prisma, QuotationStatus } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  calculateInvoiceTotals,
  calculateLineItem,
} from "../utils/money";

type TransactionClient = Prisma.TransactionClient;

export interface QuotationItemInput {
  itemId?: string | null;
  itemName?: string;
  hsnSac?: string | null;
  quantity: number;
  unit?: string | null;
  rate: number;
  discountPercent?: number;
  gstRate?: number;
}

export interface CreateQuotationInput {
  customerId?: string | null;
  date?: Date;
  expiryDate?: Date | null;
  items: QuotationItemInput[];
  notes?: string | null;
  terms?: string | null;
}

export interface ListQuotationOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: QuotationStatus;
  from?: Date;
  to?: Date;
}

const MAX_ITEMS = 100;

function cleanString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }

  const result = value.trim();
  return result || null;
}

function validateDate(
  value: Date | undefined,
  field: string,
): Date | undefined {
  if (value === undefined) return undefined;

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return value;
}

function positiveNumber(value: unknown, field: string): number {
  const result = Number(value);

  if (!Number.isFinite(result) || result <= 0) {
    throw new AppError(`${field} must be greater than zero`, 400);
  }

  return result;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const result = Number(value);

  if (!Number.isFinite(result) || result < 0) {
    throw new AppError(`${field} cannot be negative`, 400);
  }

  return result;
}

async function getNextQuotationNumber(
  businessId: string,
  tx: TransactionClient,
): Promise<string> {
  const sequences = await tx.$queryRaw<
    Array<{ id: string; prefix: string; nextNumber: number }>
  >`
    SELECT "id", "prefix", "nextNumber"
    FROM "invoice_sequences"
    WHERE "businessId" = ${businessId}
      AND "type" = 'quotation'
    FOR UPDATE
  `;

  const sequence = sequences[0];

  if (!sequence) {
    throw new AppError(
      "Quotation number sequence is not configured for this business",
      500,
    );
  }

  const nextNumber = Number(sequence.nextNumber);

  if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
    throw new AppError("Invalid quotation number sequence", 500);
  }

  await tx.invoiceSequence.update({
    where: { id: sequence.id },
    data: { nextNumber: nextNumber + 1 },
  });

  return `${sequence.prefix}-${String(nextNumber).padStart(6, "0")}`;
}

/**
 * Create a quotation.
 *
 * A quotation does not deduct stock or create a sale.
 */
export async function createQuotation(
  businessId: string,
  input: CreateQuotationInput,
) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError("At least one quotation item is required", 400);
  }

  if (input.items.length > MAX_ITEMS) {
    throw new AppError(
      `A quotation cannot contain more than ${MAX_ITEMS} items`,
      400,
    );
  }

  const date = validateDate(input.date, "quotation date") ?? new Date();
  const expiryDate =
    input.expiryDate === null
      ? null
      : validateDate(input.expiryDate, "expiry date") ?? null;

  if (expiryDate && expiryDate < date) {
    throw new AppError(
      "Expiry date cannot be before the quotation date",
      400,
    );
  }

  const customerId = cleanString(input.customerId, "customer");
  const notes = cleanString(input.notes, "notes");
  const terms = cleanString(input.terms, "terms");

  return prisma.$transaction(
    async (tx) => {
      const business = await tx.business.findFirst({
        where: { id: businessId, deletedAt: null },
        select: { id: true, state: true },
      });

      if (!business) {
        throw new AppError("Business not found", 404);
      }

      let customerState: string | null = null;

      if (customerId) {
        const customer = await tx.customer.findFirst({
          where: {
            id: customerId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: { id: true, state: true },
        });

        if (!customer) {
          throw new AppError("Customer not found or inactive", 404);
        }

        customerState = customer.state;
      }

      const isInterState = Boolean(
        business.state &&
          customerState &&
          business.state.trim().toLowerCase() !==
            customerState.trim().toLowerCase(),
      );

      const normalizedLines = input.items.map((line, index) => ({
        line,
        index,
        itemId: cleanString(line.itemId, "item ID"),
      }));

      const itemIds = [
        ...new Set(
          normalizedLines
            .map(({ itemId }) => itemId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      const databaseItems = itemIds.length
        ? await tx.item.findMany({
            where: {
              id: { in: itemIds },
              businessId,
              deletedAt: null,
              status: "ACTIVE",
            },
            select: {
              id: true,
              name: true,
              hsnSac: true,
              gstRate: true,
              unit: {
                select: { shortName: true },
              },
            },
          })
        : [];

      const itemMap = new Map(
        databaseItems.map((item) => [item.id, item]),
      );

      const lines = normalizedLines.map(({ line, index, itemId }) => {
        const databaseItem = itemId ? itemMap.get(itemId) : undefined;

        if (itemId && !databaseItem) {
          throw new AppError(
            `Item at position ${index + 1} was not found or is inactive`,
            404,
          );
        }

        const itemName =
          cleanString(line.itemName, "item name") ??
          databaseItem?.name ??
          null;

        if (!itemName) {
          throw new AppError(
            `Item name is required at position ${index + 1}`,
            400,
          );
        }

        const quantity = positiveNumber(
          line.quantity,
          `Quantity for ${itemName}`,
        );

        const rate = nonNegativeNumber(
          line.rate,
          `Rate for ${itemName}`,
        );

        const discountPercent = nonNegativeNumber(
          line.discountPercent ?? 0,
          `Discount for ${itemName}`,
        );

        if (discountPercent > 100) {
          throw new AppError(
            `Discount for ${itemName} cannot exceed 100%`,
            400,
          );
        }

        const gstRate =
          line.gstRate === undefined || line.gstRate === null
            ? Number(databaseItem?.gstRate ?? 0)
            : nonNegativeNumber(line.gstRate, `GST rate for ${itemName}`);

        if (gstRate > 100) {
          throw new AppError(
            `GST rate for ${itemName} cannot exceed 100%`,
            400,
          );
        }

        const calculation = calculateLineItem({
          quantity,
          rate,
          discountPercent,
          gstRate,
          isInterState,
        });

        return {
          itemId,
          itemName,
          hsnSac:
            cleanString(line.hsnSac, "HSN/SAC") ??
            databaseItem?.hsnSac ??
            null,
          unit:
            cleanString(line.unit, "unit") ??
            databaseItem?.unit?.shortName ??
            null,
          ...calculation,
        };
      });

      const totals = calculateInvoiceTotals(lines);
      const quotationNumber = await getNextQuotationNumber(businessId, tx);

      return tx.quotation.create({
        data: {
          businessId,
          quotationNumber,
          customerId,
          date,
          expiryDate,
          status: "DRAFT",
          subtotal: totals.subtotal.toFixed(2),
          discountAmount: totals.discountAmount.toFixed(2),
          taxableAmount: totals.taxableAmount.toFixed(2),
          cgstAmount: totals.cgstAmount.toFixed(2),
          sgstAmount: totals.sgstAmount.toFixed(2),
          igstAmount: totals.igstAmount.toFixed(2),
          grandTotal: totals.grandTotal.toFixed(2),
          notes,
          terms,
          items: {
            create: lines.map((line) => ({
              itemId: line.itemId,
              itemName: line.itemName,
              hsnSac: line.hsnSac,
              quantity: line.quantity.toFixed(3),
              unit: line.unit,
              rate: line.rate.toFixed(2),
              discountPercent: line.discountPercent.toFixed(2),
              discountAmount: line.discountAmount.toFixed(2),
              taxableAmount: line.taxableAmount.toFixed(2),
              gstRate: line.gstRate.toFixed(2),
              cgstAmount: line.cgstAmount.toFixed(2),
              sgstAmount: line.sgstAmount.toFixed(2),
              igstAmount: line.igstAmount.toFixed(2),
              amount: line.amount.toFixed(2),
            })),
          },
        },
        include: {
          customer: true,
          items: true,
        },
      });
    },
    {
      maxWait: 10_000,
      timeout: 20_000,
    },
  );
}

/**
 * List quotations with pagination and optional filters.
 */
export async function listQuotations(
  businessId: string,
  options: ListQuotationOptions = {},
) {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
  const search = options.search?.trim();

  const from = validateDate(options.from, "from date");
  const to = validateDate(options.to, "to date");

  if (from && to && from > to) {
    throw new AppError("'from' date cannot be after 'to' date", 400);
  }

  const where: Prisma.QuotationWhereInput = {
    businessId,
    ...(options.status ? { status: options.status } : {}),
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            {
              quotationNumber: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              notes: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              customer: {
                is: {
                  name: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
              },
            },
          ],
        }
      : {}),
  };

  const [data, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      include: {
        customer: true,
        items: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.quotation.count({ where }),
  ]);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Fetch one quotation belonging to the specified business.
 */
export async function getQuotationById(
  businessId: string,
  quotationId: string,
) {
  const quotation = await prisma.quotation.findFirst({
    where: {
      id: quotationId,
      businessId,
    },
    include: {
      customer: true,
      items: true,
    },
  });

  if (!quotation) {
    throw new AppError("Quotation not found", 404);
  }

  return quotation;
}

/**
 * Update quotation status without allowing a converted quotation
 * to be modified again.
 */
export async function updateQuotationStatus(
  businessId: string,
  quotationId: string,
  status: QuotationStatus,
) {
  const allowedStatuses: QuotationStatus[] = [
    "DRAFT",
    "SENT",
    "ACCEPTED",
    "REJECTED",
    "EXPIRED",
  ];

  if (!allowedStatuses.includes(status)) {
    throw new AppError("Invalid quotation status", 400);
  }

  return prisma.$transaction(async (tx) => {
    const quotation = await tx.quotation.findFirst({
      where: {
        id: quotationId,
        businessId,
      },
      select: {
        id: true,
        status: true,
        expiryDate: true,
      },
    });

    if (!quotation) {
      throw new AppError("Quotation not found", 404);
    }

    if (quotation.status === "CONVERTED") {
      throw new AppError(
        "A converted quotation cannot be changed",
        409,
      );
    }

    if (
      quotation.expiryDate &&
      quotation.expiryDate < new Date() &&
      status === "ACCEPTED"
    ) {
      throw new AppError(
        "An expired quotation cannot be accepted",
        409,
      );
    }

    return tx.quotation.update({
      where: { id: quotation.id },
      data: { status },
      include: {
        customer: true,
        items: true,
      },
    });
  });
}