import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export type UpdateExpenseInput = {
  amount?: number;
  date?: Date;
  categoryId?: string | null;
  category?: string | null;
  description?: string | null;
  paymentMethod?: string | null;
  bankAccountId?: string | null;
  attachmentUrl?: string | null;
  notes?: string | null;
};

function clean(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function money(value: unknown): Prisma.Decimal {
  let result: Prisma.Decimal;

  try {
    result = new Prisma.Decimal(String(value));
  } catch {
    throw new AppError("Invalid expense amount", 400);
  }

  if (!result.isFinite() || result.lte(0)) {
    throw new AppError("Expense amount must be greater than zero", 400);
  }

  if (result.decimalPlaces() > 2) {
    throw new AppError(
      "Expense amount cannot have more than two decimal places",
      400,
    );
  }

  return result;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError("Invalid expense date", 400);
  }

  return value;
}

async function resolveCategory(
  tx: Prisma.TransactionClient,
  businessId: string,
  categoryId: string | null | undefined,
  categoryName: string | null | undefined,
  existingCategoryId: string | null,
): Promise<string | null> {
  if (categoryId !== undefined) {
    const id = clean(categoryId);

    if (!id) return null;

    const category = await tx.expenseCategory.findFirst({
      where: { id, businessId },
      select: { id: true },
    });

    if (!category) {
      throw new AppError("Expense category not found", 404);
    }

    return category.id;
  }

  if (categoryName !== undefined) {
    const name = clean(categoryName);

    if (!name) return null;

    const category = await tx.expenseCategory.upsert({
      where: {
        businessId_name: { businessId, name },
      },
      create: { businessId, name },
      update: {},
      select: { id: true },
    });

    return category.id;
  }

  return existingCategoryId;
}

async function changeAccountBalance(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    accountId: string;
    amount: Prisma.Decimal;
    direction: "INCREMENT" | "DECREMENT";
    date: Date;
    expenseId: string;
    description: string;
  },
): Promise<void> {
  const account = await tx.bankAccount.findFirst({
    where: {
      id: args.accountId,
      businessId: args.businessId,
    },
    select: {
      id: true,
      currentBalance: true,
      status: true,
    },
  });

  if (!account) {
    throw new AppError("Cash/bank account not found", 404);
  }

  if (args.direction === "DECREMENT" && account.status !== "ACTIVE") {
    throw new AppError(
      "Cannot charge an archived cash/bank account",
      409,
    );
  }

  const updated = await tx.bankAccount.update({
    where: { id: account.id },
    data: {
      currentBalance:
        args.direction === "INCREMENT"
          ? { increment: args.amount }
          : { decrement: args.amount },
    },
    select: { currentBalance: true },
  });

  await tx.bankTransaction.create({
    data: {
      businessId: args.businessId,
      bankAccountId: account.id,
      date: args.date,
      type: "ADJUSTMENT",
      amount: args.amount,
      balance: updated.currentBalance,
      referenceType: "EXPENSE",
      referenceId: args.expenseId,
      description: args.description,
    },
  });
}

export async function updateExpense(
  businessId: string,
  expenseId: string,
  input: UpdateExpenseInput,
) {
  if (Object.keys(input).length === 0) {
    throw new AppError("Provide at least one field to update", 400);
  }

  if (
    input.description != null &&
    input.description.trim().length > 1000
  ) {
    throw new AppError("Description cannot exceed 1000 characters", 400);
  }

  if (input.notes != null && input.notes.length > 5000) {
    throw new AppError("Notes cannot exceed 5000 characters", 400);
  }

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: expenseId, businessId },
      });

      if (!existing) {
        throw new AppError("Expense not found", 404);
      }

      const nextAmount =
        input.amount === undefined
          ? existing.amount
          : money(input.amount);

      const nextDate =
        input.date === undefined
          ? existing.date
          : validDate(input.date);

      const nextBankAccountId =
        input.bankAccountId === undefined
          ? existing.bankAccountId
          : clean(input.bankAccountId);

      const nextCategoryId = await resolveCategory(
        tx,
        businessId,
        input.categoryId,
        input.category,
        existing.categoryId,
      );

      // Reverse the previous expense's bank impact first.
      if (existing.bankAccountId) {
        await changeAccountBalance(tx, {
          businessId,
          accountId: existing.bankAccountId,
          amount: existing.amount,
          direction: "INCREMENT",
          date: nextDate,
          expenseId,
          description: "Expense edit: reverse previous amount",
        });
      }

      // Apply the corrected expense to the selected account.
      if (nextBankAccountId) {
        await changeAccountBalance(tx, {
          businessId,
          accountId: nextBankAccountId,
          amount: nextAmount,
          direction: "DECREMENT",
          date: nextDate,
          expenseId,
          description: "Expense edit: apply corrected amount",
        });
      }

      return tx.expense.update({
        where: { id: existing.id },
        data: {
          amount: nextAmount,
          date: nextDate,
          categoryId: nextCategoryId,
          ...(input.description !== undefined
            ? { description: clean(input.description) }
            : {}),
          ...(input.paymentMethod !== undefined
            ? { paymentMethod: clean(input.paymentMethod)?.toUpperCase() ?? null }
            : {}),
          bankAccountId: nextBankAccountId,
          ...(input.attachmentUrl !== undefined
            ? { attachmentUrl: clean(input.attachmentUrl) }
            : {}),
          ...(input.notes !== undefined
            ? { notes: clean(input.notes) }
            : {}),
        },
        include: {
          category: { select: { id: true, name: true } },
          bankAccount: {
            select: { id: true, name: true, isCash: true },
          },
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}

export async function deleteExpense(
  businessId: string,
  expenseId: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: expenseId, businessId },
      });

      if (!existing) {
        throw new AppError("Expense not found", 404);
      }

      // Restore the account balance before removing the expense.
      if (existing.bankAccountId) {
        await changeAccountBalance(tx, {
          businessId,
          accountId: existing.bankAccountId,
          amount: existing.amount,
          direction: "INCREMENT",
          date: new Date(),
          expenseId,
          description: "Expense deleted: reverse recorded amount",
        });
      }

      await tx.expense.delete({
        where: { id: existing.id },
      });

      return {
        id: existing.id,
        deleted: true,
        message: "Expense deleted and account balance adjusted",
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}