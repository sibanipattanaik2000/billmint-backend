import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export type OtherIncomeListOptions = {
  page: number;
  limit: number;
  search?: string;
  from?: Date;
  to?: Date;
};

export type CreateOtherIncomeInput = {
  amount: number;
  date?: Date;
  category?: string | null;
  paymentMethod: string;
  description?: string | null;
  notes?: string | null;
  reference?: string | null;
  bankAccountId?: string | null;
};

function cleanString(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length ? cleaned : null;
}

function parseAmount(value: unknown): Prisma.Decimal {
  let amount: Prisma.Decimal;

  try {
    amount = new Prisma.Decimal(String(value));
  } catch {
    throw new AppError("Invalid income amount", 400);
  }

  if (!amount.isFinite() || amount.lte(0)) {
    throw new AppError("Income amount must be greater than zero", 400);
  }

  if (amount.decimalPlaces() > 2) {
    throw new AppError("Income amount cannot have more than two decimal places", 400);
  }

  return amount;
}

function parseDate(value?: Date): Date {
  if (value === undefined) return new Date();

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError("Invalid income date", 400);
  }

  return value;
}

export async function listOtherIncome(
  businessId: string,
  options: OtherIncomeListOptions,
) {
  const page = Math.max(1, Math.trunc(options.page || 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit || 20)));

  if (
    options.from &&
    options.to &&
    options.from.getTime() > options.to.getTime()
  ) {
    throw new AppError("'from' date cannot be after 'to' date", 400);
  }

  const search = options.search?.trim();

  const where: Prisma.OtherIncomeWhereInput = {
    businessId,
    ...(options.from || options.to
      ? {
          date: {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lte: options.to } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { category: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            { notes: { contains: search, mode: "insensitive" } },
            { paymentMethod: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [data, total, aggregate] = await prisma.$transaction([
    prisma.otherIncome.findMany({
      where,
      include: {
        bankAccount: {
          select: { id: true, name: true, isCash: true },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.otherIncome.count({ where }),
    prisma.otherIncome.aggregate({
      where,
      _sum: { amount: true },
    }),
  ]);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    summary: {
      totalAmount: Number(aggregate._sum.amount ?? 0),
      count: total,
    },
  };
}

export async function getOtherIncome(
  businessId: string,
  incomeId: string,
) {
  const income = await prisma.otherIncome.findFirst({
    where: {
      id: incomeId,
      businessId,
    },
    include: {
      bankAccount: {
        select: { id: true, name: true, isCash: true },
      },
    },
  });

  if (!income) {
    throw new AppError("Income record not found", 404);
  }

  return income;
}

export async function createOtherIncome(
  businessId: string,
  input: CreateOtherIncomeInput,
) {
  const amount = parseAmount(input.amount);
  const date = parseDate(input.date);
  const category = cleanString(input.category);
  const paymentMethod = cleanString(input.paymentMethod);
  const description = cleanString(input.description);
  const notes = cleanString(input.notes);
  const reference = cleanString(input.reference);
  const bankAccountId = cleanString(input.bankAccountId);

  if (!paymentMethod) {
    throw new AppError("Payment method is required", 400);
  }

  if (paymentMethod.length > 50) {
    throw new AppError("Payment method cannot exceed 50 characters", 400);
  }

  if (category && category.length > 200) {
    throw new AppError("Category cannot exceed 200 characters", 400);
  }

  if (description && description.length > 1000) {
    throw new AppError("Description cannot exceed 1000 characters", 400);
  }

  if (notes && notes.length > 5000) {
    throw new AppError("Notes cannot exceed 5000 characters", 400);
  }

  if (reference && reference.length > 200) {
    throw new AppError("Reference cannot exceed 200 characters", 400);
  }

  return prisma.$transaction(
    async (tx) => {
      let updatedAccount:
        | {
            id: string;
            name: string;
            currentBalance: Prisma.Decimal;
            isCash: boolean;
          }
        | null = null;

      if (bankAccountId) {
        const account = await tx.bankAccount.findFirst({
          where: {
            id: bankAccountId,
            businessId,
            status: "ACTIVE",
          },
          select: { id: true },
        });

        if (!account) {
          throw new AppError(
            "Active cash/bank account not found for this business",
            404,
          );
        }

        updatedAccount = await tx.bankAccount.update({
          where: { id: account.id },
          data: {
            currentBalance: { increment: amount },
          },
          select: {
            id: true,
            name: true,
            currentBalance: true,
            isCash: true,
          },
        });
      }

      const income = await tx.otherIncome.create({
        data: {
          businessId,
          amount,
          date,
          category,
          paymentMethod,
          description,
          notes,
          reference,
          bankAccountId: updatedAccount?.id ?? null,
        },
        include: {
          bankAccount: {
            select: { id: true, name: true, isCash: true },
          },
        },
      });

      if (updatedAccount) {
        await tx.bankTransaction.create({
          data: {
            businessId,
            bankAccountId: updatedAccount.id,
            date,
            type: "RECEIPT",
            amount,
            balance: updatedAccount.currentBalance,
            referenceType: "OTHER_INCOME",
            referenceId: income.id,
            description: description ?? category ?? "Other income recorded",
          },
        });
      }

      return income;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}
