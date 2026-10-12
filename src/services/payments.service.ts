import { InvoiceStatus, Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

type TransactionClient = Prisma.TransactionClient;

export interface PaymentAllocationInput {
  invoiceId: string;
  amount: number;
}

export interface CreatePaymentInput {
  customerId?: string | null;
  supplierId?: string | null;
  amount: number;
  date?: Date;
  paymentMethod: string;
  reference?: string | null;
  notes?: string | null;
  bankAccountId?: string | null;
  allocations?: PaymentAllocationInput[];
  createdById?: string | null;
}

interface ListPaymentOptions {
  page?: number;
  limit?: number;
  search?: string;
  from?: Date;
  to?: Date;
}

const MAX_ALLOCATIONS = 100;
const MONEY_PRECISION = 2;

function cleanOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "string") {
    throw new AppError("Invalid text field", 400);
  }

  const result = value.trim();
  return result.length ? result : null;
}

function parsePositiveAmount(value: unknown, field = "Amount"): Prisma.Decimal {
  let amount: Prisma.Decimal;

  try {
    amount = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    throw new AppError(`${field} must be a valid amount`, 400);
  }

  if (!amount.isFinite() || amount.lte(0)) {
    throw new AppError(`${field} must be greater than zero`, 400);
  }

  if (amount.decimalPlaces() > MONEY_PRECISION) {
    throw new AppError(`${field} cannot have more than 2 decimal places`, 400);
  }

  return amount;
}

function parseDate(value?: Date): Date {
  const date = value ?? new Date();

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new AppError("Invalid payment date", 400);
  }

  return date;
}

function normalizePaymentMethod(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("Payment method is required", 400);
  }

  const method = value.trim().toUpperCase();

  if (method.length > 50) {
    throw new AppError("Payment method cannot exceed 50 characters", 400);
  }

  return method;
}

function normalizeAllocations(
  allocations: PaymentAllocationInput[] | undefined,
): Array<{ invoiceId: string; amount: Prisma.Decimal }> {
  if (allocations === undefined) return [];

  if (!Array.isArray(allocations)) {
    throw new AppError("Allocations must be an array", 400);
  }

  if (allocations.length > MAX_ALLOCATIONS) {
    throw new AppError(
      `A payment cannot contain more than ${MAX_ALLOCATIONS} allocations`,
      400,
    );
  }

  const seen = new Set<string>();

  return allocations.map((allocation) => {
    if (
      !allocation ||
      typeof allocation.invoiceId !== "string" ||
      !allocation.invoiceId.trim()
    ) {
      throw new AppError("Every allocation requires a valid invoiceId", 400);
    }

    const invoiceId = allocation.invoiceId.trim();

    if (seen.has(invoiceId)) {
      throw new AppError(
        "An invoice cannot appear more than once in the same payment",
        400,
      );
    }

    seen.add(invoiceId);

    return {
      invoiceId,
      amount: parsePositiveAmount(allocation.amount, "Allocation amount"),
    };
  });
}

function assertAllocationTotal(
  paymentAmount: Prisma.Decimal,
  allocations: Array<{ invoiceId: string; amount: Prisma.Decimal }>,
): void {
  const allocated = allocations.reduce(
    (total, allocation) => total.plus(allocation.amount),
    new Prisma.Decimal(0),
  );

  if (allocated.gt(paymentAmount)) {
    throw new AppError(
      "Total invoice allocations cannot exceed the payment amount",
      400,
    );
  }
}

async function validateBankAccount(
  tx: TransactionClient,
  businessId: string,
  bankAccountId: string | null,
) {
  if (!bankAccountId) return null;

  const account = await tx.bankAccount.findFirst({
    where: {
      id: bankAccountId,
      businessId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!account) {
    throw new AppError("Bank or cash account not found or inactive", 404);
  }

  return account;
}

async function recordBankTransaction(
  tx: TransactionClient,
  input: {
    businessId: string;
    bankAccountId: string | null;
    amount: Prisma.Decimal;
    date: Date;
    direction: "IN" | "OUT";
    referenceType: string;
    referenceId: string;
    description: string;
  },
): Promise<void> {
  if (!input.bankAccountId) return;

  const account = await tx.bankAccount.findFirst({
    where: {
      id: input.bankAccountId,
      businessId: input.businessId,
      status: "ACTIVE",
    },
    select: {
      id: true,
    },
  });

  if (!account) {
    throw new AppError("Bank or cash account not found or inactive", 404);
  }

  const change =
    input.direction === "IN"
      ? input.amount
      : input.amount.negated();

  const updated = await tx.bankAccount.update({
    where: { id: account.id },
    data: {
      currentBalance: { increment: change },
    },
    select: {
      currentBalance: true,
    },
  });

  await tx.bankTransaction.create({
    data: {
      businessId: input.businessId,
      bankAccountId: account.id,
      date: input.date,
      type: input.direction === "IN" ? "RECEIPT" : "PAYMENT",
      amount: input.amount,
      balance: updated.currentBalance,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
    },
  });
}

function invoiceStatus(
  grandTotal: Prisma.Decimal,
  paidAmount: Prisma.Decimal,
): InvoiceStatus {
  if (paidAmount.gte(grandTotal)) return "PAID";
  if (paidAmount.gt(0)) return "PARTIALLY_PAID";
  return "UNPAID";
}

/* =========================================================
   PAYMENTS RECEIVED FROM CUSTOMERS
========================================================= */

export async function createPaymentIn(
  businessId: string,
  input: CreatePaymentInput,
) {
  const amount = parsePositiveAmount(input.amount);
  const date = parseDate(input.date);
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const customerId = cleanOptionalString(input.customerId);
  const bankAccountId = cleanOptionalString(input.bankAccountId);
  const reference = cleanOptionalString(input.reference);
  const notes = cleanOptionalString(input.notes);
  const allocations = normalizeAllocations(input.allocations);

  assertAllocationTotal(amount, allocations);

  if (allocations.length > 0 && !customerId) {
    throw new AppError(
      "A customer is required when allocating a payment to invoices",
      400,
    );
  }

  return prisma.$transaction(
    async (tx) => {
      if (customerId) {
        const customer = await tx.customer.findFirst({
          where: {
            id: customerId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: { id: true },
        });

        if (!customer) {
          throw new AppError("Customer not found or inactive", 404);
        }
      }

      await validateBankAccount(tx, businessId, bankAccountId);

      const invoices: Array<{
        id: string;
        customerId: string | null;
        grandTotal: Prisma.Decimal;
        paidAmount: Prisma.Decimal;
        balanceAmount: Prisma.Decimal;
        status: InvoiceStatus;
      }> = [];

      for (const allocation of allocations) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "sales"
          WHERE "id" = ${allocation.invoiceId}::uuid
            AND "businessId" = ${businessId}::uuid
            AND "deletedAt" IS NULL
          FOR UPDATE
        `;

        if (locked.length === 0) {
          throw new AppError(
            `Sales invoice not found: ${allocation.invoiceId}`,
            404,
          );
        }

        const invoice = await tx.sale.findFirst({
          where: {
            id: allocation.invoiceId,
            businessId,
            deletedAt: null,
          },
          select: {
            id: true,
            customerId: true,
            grandTotal: true,
            paidAmount: true,
            balanceAmount: true,
            status: true,
          },
        });

        if (!invoice) {
          throw new AppError("Sales invoice not found", 404);
        }

        if (invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
          throw new AppError(
            `Invoice ${invoice.id} cannot receive a payment in its current status`,
            400,
          );
        }

        if (invoice.customerId !== customerId) {
          throw new AppError(
            "Every allocated invoice must belong to the selected customer",
            400,
          );
        }

        if (allocation.amount.gt(invoice.balanceAmount)) {
          throw new AppError(
            `Allocation exceeds the outstanding balance for invoice ${invoice.id}`,
            400,
          );
        }

        invoices.push(invoice);
      }

      const payment = await tx.paymentIn.create({
        data: {
          businessId,
          customerId,
          amount,
          date,
          paymentMethod,
          reference,
          notes,
          bankAccountId,
          createdById: cleanOptionalString(input.createdById),
        },
      });

      for (const allocation of allocations) {
        const invoice = invoices.find(
          (entry) => entry.id === allocation.invoiceId,
        );

        if (!invoice) {
          throw new AppError("Unable to resolve invoice allocation", 500);
        }

        const newPaidAmount = invoice.paidAmount.plus(allocation.amount);
        const newBalance = invoice.balanceAmount.minus(allocation.amount);

        await tx.paymentInAllocation.create({
          data: {
            paymentInId: payment.id,
            saleId: invoice.id,
            amount: allocation.amount,
          },
        });

        await tx.sale.update({
          where: { id: invoice.id },
          data: {
            paidAmount: newPaidAmount,
            balanceAmount: newBalance,
            status: invoiceStatus(invoice.grandTotal, newPaidAmount),
          },
        });
      }

      if (customerId) {
        await tx.customer.update({
          where: { id: customerId },
          data: {
            currentBalance: { decrement: amount },
          },
        });
      }

      await recordBankTransaction(tx, {
        businessId,
        bankAccountId,
        amount,
        date,
        direction: "IN",
        referenceType: "PAYMENT_IN",
        referenceId: payment.id,
        description: `Customer payment received${reference ? ` (${reference})` : ""}`,
      });

      return tx.paymentIn.findUniqueOrThrow({
        where: { id: payment.id },
        include: {
          customer: true,
          bankAccount: true,
          allocations: {
            include: {
              sale: {
                select: {
                  id: true,
                  invoiceNumber: true,
                  grandTotal: true,
                  paidAmount: true,
                  balanceAmount: true,
                  status: true,
                },
              },
            },
          },
        },
      });
    },
    {
      maxWait: 10_000,
      timeout: 20_000,
    },
  );
}

export async function listPaymentsIn(
  businessId: string,
  options: ListPaymentOptions = {},
) {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
  const search = options.search?.trim();
  const from = options.from;
  const to = options.to;

  if (from && Number.isNaN(from.getTime())) {
    throw new AppError("Invalid from date", 400);
  }

  if (to && Number.isNaN(to.getTime())) {
    throw new AppError("Invalid to date", 400);
  }

  if (from && to && from > to) {
    throw new AppError("'from' date cannot be after 'to' date", 400);
  }

  const where: Prisma.PaymentInWhereInput = {
    businessId,
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
            { reference: { contains: search, mode: "insensitive" } },
            { paymentMethod: { contains: search, mode: "insensitive" } },
            { notes: { contains: search, mode: "insensitive" } },
            { customer: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [data, total] = await Promise.all([
    prisma.paymentIn.findMany({
      where,
      include: {
        customer: true,
        bankAccount: true,
        allocations: {
          include: {
            sale: {
              select: {
                id: true,
                invoiceNumber: true,
                grandTotal: true,
                paidAmount: true,
                balanceAmount: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.paymentIn.count({ where }),
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

/* =========================================================
   PAYMENTS MADE TO SUPPLIERS
========================================================= */

export async function createPaymentOut(
  businessId: string,
  input: CreatePaymentInput,
) {
  const amount = parsePositiveAmount(input.amount);
  const date = parseDate(input.date);
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const supplierId = cleanOptionalString(input.supplierId);
  const bankAccountId = cleanOptionalString(input.bankAccountId);
  const reference = cleanOptionalString(input.reference);
  const notes = cleanOptionalString(input.notes);
  const allocations = normalizeAllocations(input.allocations);

  assertAllocationTotal(amount, allocations);

  if (allocations.length > 0 && !supplierId) {
    throw new AppError(
      "A supplier is required when allocating a payment to purchase bills",
      400,
    );
  }

  return prisma.$transaction(
    async (tx) => {
      if (supplierId) {
        const supplier = await tx.supplier.findFirst({
          where: {
            id: supplierId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: { id: true },
        });

        if (!supplier) {
          throw new AppError("Supplier not found or inactive", 404);
        }
      }

      await validateBankAccount(tx, businessId, bankAccountId);

      const invoices: Array<{
        id: string;
        supplierId: string | null;
        grandTotal: Prisma.Decimal;
        paidAmount: Prisma.Decimal;
        balanceAmount: Prisma.Decimal;
        status: InvoiceStatus;
      }> = [];

      for (const allocation of allocations) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "purchases"
          WHERE "id" = ${allocation.invoiceId}::uuid
            AND "businessId" = ${businessId}::uuid
            AND "deletedAt" IS NULL
          FOR UPDATE
        `;

        if (locked.length === 0) {
          throw new AppError(
            `Purchase bill not found: ${allocation.invoiceId}`,
            404,
          );
        }

        const invoice = await tx.purchase.findFirst({
          where: {
            id: allocation.invoiceId,
            businessId,
            deletedAt: null,
          },
          select: {
            id: true,
            supplierId: true,
            grandTotal: true,
            paidAmount: true,
            balanceAmount: true,
            status: true,
          },
        });

        if (!invoice) {
          throw new AppError("Purchase bill not found", 404);
        }

        if (invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
          throw new AppError(
            `Purchase bill ${invoice.id} cannot receive a payment in its current status`,
            400,
          );
        }

        if (invoice.supplierId !== supplierId) {
          throw new AppError(
            "Every allocated bill must belong to the selected supplier",
            400,
          );
        }

        if (allocation.amount.gt(invoice.balanceAmount)) {
          throw new AppError(
            `Allocation exceeds the outstanding balance for bill ${invoice.id}`,
            400,
          );
        }

        invoices.push(invoice);
      }

      const payment = await tx.paymentOut.create({
        data: {
          businessId,
          supplierId,
          amount,
          date,
          paymentMethod,
          reference,
          notes,
          bankAccountId,
          createdById: cleanOptionalString(input.createdById),
        },
      });

      for (const allocation of allocations) {
        const invoice = invoices.find(
          (entry) => entry.id === allocation.invoiceId,
        );

        if (!invoice) {
          throw new AppError("Unable to resolve purchase allocation", 500);
        }

        const newPaidAmount = invoice.paidAmount.plus(allocation.amount);
        const newBalance = invoice.balanceAmount.minus(allocation.amount);

        await tx.paymentOutAllocation.create({
          data: {
            paymentOutId: payment.id,
            purchaseId: invoice.id,
            amount: allocation.amount,
          },
        });

        await tx.purchase.update({
          where: { id: invoice.id },
          data: {
            paidAmount: newPaidAmount,
            balanceAmount: newBalance,
            status: invoiceStatus(invoice.grandTotal, newPaidAmount),
          },
        });
      }

      if (supplierId) {
        await tx.supplier.update({
          where: { id: supplierId },
          data: {
            currentBalance: { decrement: amount },
          },
        });
      }

      await recordBankTransaction(tx, {
        businessId,
        bankAccountId,
        amount,
        date,
        direction: "OUT",
        referenceType: "PAYMENT_OUT",
        referenceId: payment.id,
        description: `Supplier payment made${reference ? ` (${reference})` : ""}`,
      });

      return tx.paymentOut.findUniqueOrThrow({
        where: { id: payment.id },
        include: {
          supplier: true,
          bankAccount: true,
          allocations: {
            include: {
              purchase: {
                select: {
                  id: true,
                  billNumber: true,
                  grandTotal: true,
                  paidAmount: true,
                  balanceAmount: true,
                  status: true,
                },
              },
            },
          },
        },
      });
    },
    {
      maxWait: 10_000,
      timeout: 20_000,
    },
  );
}

export async function listPaymentsOut(
  businessId: string,
  options: ListPaymentOptions = {},
) {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
  const search = options.search?.trim();
  const from = options.from;
  const to = options.to;

  if (from && Number.isNaN(from.getTime())) {
    throw new AppError("Invalid from date", 400);
  }

  if (to && Number.isNaN(to.getTime())) {
    throw new AppError("Invalid to date", 400);
  }

  if (from && to && from > to) {
    throw new AppError("'from' date cannot be after 'to' date", 400);
  }

  const where: Prisma.PaymentOutWhereInput = {
    businessId,
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
            { reference: { contains: search, mode: "insensitive" } },
            { paymentMethod: { contains: search, mode: "insensitive" } },
            { notes: { contains: search, mode: "insensitive" } },
            { supplier: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [data, total] = await Promise.all([
    prisma.paymentOut.findMany({
      where,
      include: {
        supplier: true,
        bankAccount: true,
        allocations: {
          include: {
            purchase: {
              select: {
                id: true,
                billNumber: true,
                grandTotal: true,
                paidAmount: true,
                balanceAmount: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.paymentOut.count({ where }),
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
