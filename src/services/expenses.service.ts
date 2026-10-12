
import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

type ExpenseListOptions = {
  page: number;
  limit: number;
  search?: string;
  categoryId?: string;
  from?: Date;
  to?: Date;
};

export type CreateExpenseInput = {
  amount: number;
  date?: Date;
  categoryId?: string | null;
  category?: string | null;
  description?: string | null;
  paymentMethod?: string | null;
  bankAccountId?: string | null;
  attachmentUrl?: string | null;
  notes?: string | null;
  createdById?: string | null;
};

function cleanString(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length ? result : null;
}

function validateAmount(value: unknown): Prisma.Decimal {
  const amount = new Prisma.Decimal(String(value));

  if (!amount.isFinite() || amount.lte(0)) {
    throw new AppError("Expense amount must be greater than zero", 400);
  }

  return amount.toDecimalPlaces(2);
}

function validateDate(value?: Date): Date {
  if (value === undefined) return new Date();

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError("Invalid expense date", 400);
  }

  return value;
}

export async function listExpenses(
  businessId: string,
  options: ExpenseListOptions,
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

  const where: Prisma.ExpenseWhereInput = {
    businessId,
    ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    ...(options.from || options.to
      ? {
          date: {
            ...(options.from ? { gte: options.from } : {}),
            ...(options.to ? { lte: options.to } : {}),
          },
        }
      : {}),
    ...(options.search?.trim()
      ? {
          OR: [
            {
              description: {
                contains: options.search.trim(),
                mode: "insensitive",
              },
            },
            {
              notes: {
                contains: options.search.trim(),
                mode: "insensitive",
              },
            },
            {
              category: {
                is: {
                  name: {
                    contains: options.search.trim(),
                    mode: "insensitive",
                  },
                },
              },
            },
          ],
        }
      : {}),
  };

  const [data, total, aggregate] = await prisma.$transaction([
    prisma.expense.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        bankAccount: {
          select: { id: true, name: true, isCash: true },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({
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

export async function getExpense(
  businessId: string,
  expenseId: string,
) {
  const expense = await prisma.expense.findFirst({
    where: {
      id: expenseId,
      businessId,
    },
    include: {
      category: { select: { id: true, name: true } },
      bankAccount: {
        select: { id: true, name: true, isCash: true },
      },
    },
  });

  if (!expense) {
    throw new AppError("Expense not found", 404);
  }

  return expense;
}

export async function listExpenseCategories(businessId: string) {
  return prisma.expenseCategory.findMany({
    where: { businessId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      isSystem: true,
    },
  });
}

export async function createExpense(
  businessId: string,
  input: CreateExpenseInput,
) {
  const amount = validateAmount(input.amount);
  const date = validateDate(input.date);
  const categoryId = cleanString(input.categoryId);
  const categoryName = cleanString(input.category);
  const bankAccountId = cleanString(input.bankAccountId);
  const paymentMethod = cleanString(input.paymentMethod)?.toUpperCase() ?? null;

  if (input.description && input.description.trim().length > 1000) {
    throw new AppError("Description cannot exceed 1000 characters", 400);
  }

  if (input.notes && input.notes.length > 5000) {
    throw new AppError("Notes cannot exceed 5000 characters", 400);
  }

  return prisma.$transaction(
    async (tx) => {
      let resolvedCategoryId: string | null = null;

      if (categoryId) {
        const category = await tx.expenseCategory.findFirst({
          where: { id: categoryId, businessId },
          select: { id: true },
        });

        if (!category) {
          throw new AppError("Expense category not found", 404);
        }

        resolvedCategoryId = category.id;
      } else if (categoryName) {
        const category = await tx.expenseCategory.upsert({
          where: {
            businessId_name: {
              businessId,
              name: categoryName,
            },
          },
          create: {
            businessId,
            name: categoryName,
          },
          update: {},
          select: { id: true },
        });

        resolvedCategoryId = category.id;
      }

      let updatedAccount: {
        id: string;
        name: string;
        currentBalance: Prisma.Decimal;
        isCash: boolean;
      } | null = null;

      if (bankAccountId) {
        const account = await tx.bankAccount.findFirst({
          where: {
            id: bankAccountId,
            businessId,
            status: "ACTIVE",
          },
          select: {
            id: true,
            name: true,
            currentBalance: true,
            isCash: true,
          },
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
            currentBalance: { decrement: amount },
          },
          select: {
            id: true,
            name: true,
            currentBalance: true,
            isCash: true,
          },
        });
      }

      const expense = await tx.expense.create({
        data: {
          businessId,
          amount,
          date,
          categoryId: resolvedCategoryId,
          description: cleanString(input.description),
          paymentMethod,
          bankAccountId: updatedAccount?.id ?? null,
          attachmentUrl: cleanString(input.attachmentUrl),
          notes: cleanString(input.notes),
          createdById: cleanString(input.createdById),
        },
        include: {
          category: { select: { id: true, name: true } },
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
            type: "PAYMENT",
            amount,
            balance: updatedAccount.currentBalance,
            referenceType: "EXPENSE",
            referenceId: expense.id,
            description:
              cleanString(input.description) ?? "Expense recorded",
          },
        });
      }

      return expense;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}
