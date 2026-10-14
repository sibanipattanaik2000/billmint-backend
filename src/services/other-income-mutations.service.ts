import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export type UpdateOtherIncomeInput = {
  amount?: number;
  date?: Date;
  category?: string | null;
  paymentMethod?: string;
  description?: string | null;
  notes?: string | null;
  reference?: string | null;
  bankAccountId?: string | null;
};

function clean(value?: string | null): string | null {
  if (value == null) return null;
  return value.trim() || null;
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
    throw new AppError(
      "Income amount cannot have more than two decimal places",
      400,
    );
  }

  return amount;
}

function parseDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError("Invalid income date", 400);
  }

  return value;
}

async function applyBalanceChange(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    accountId: string;
    amount: Prisma.Decimal;
    direction: "INCREMENT" | "DECREMENT";
    date: Date;
    incomeId: string;
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
      status: true,
    },
  });

  if (!account) {
    throw new AppError("Cash/bank account not found", 404);
  }

  if (args.direction === "INCREMENT" && account.status !== "ACTIVE") {
    throw new AppError(
      "Cannot add income to an archived cash/bank account",
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
    select: {
      currentBalance: true,
    },
  });

  await tx.bankTransaction.create({
    data: {
      businessId: args.businessId,
      bankAccountId: account.id,
      date: args.date,
      type: args.direction === "INCREMENT" ? "RECEIPT" : "ADJUSTMENT",
      amount: args.amount,
      balance: updated.currentBalance,
      referenceType: "OTHER_INCOME",
      referenceId: args.incomeId,
      description: args.description,
    },
  });
}

export async function updateOtherIncome(
  businessId: string,
  incomeId: string,
  input: UpdateOtherIncomeInput,
) {
  if (Object.keys(input).length === 0) {
    throw new AppError("Provide at least one field to update", 400);
  }

  if (input.category != null && input.category.trim().length > 200) {
    throw new AppError("Category cannot exceed 200 characters", 400);
  }

  if (input.description != null && input.description.trim().length > 1000) {
    throw new AppError("Description cannot exceed 1000 characters", 400);
  }

  if (input.notes != null && input.notes.length > 5000) {
    throw new AppError("Notes cannot exceed 5000 characters", 400);
  }
  if (
    input.paymentMethod !== undefined &&
    (!input.paymentMethod.trim() || input.paymentMethod.trim().length > 50)
  ) {
    throw new AppError("Payment method must contain 1–50 characters", 400);
  }
  if (
  input.reference != null &&
  input.reference.trim().length > 200
) {
  throw new AppError("Reference cannot exceed 200 characters", 400);
}

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.otherIncome.findFirst({
        where: { id: incomeId, businessId },
      });

      if (!existing) {
        throw new AppError("Income record not found", 404);
      }

      const amount =
        input.amount === undefined
          ? existing.amount
          : parseAmount(input.amount);

      const date =
        input.date === undefined ? existing.date : parseDate(input.date);

      const bankAccountId =
        input.bankAccountId === undefined
          ? existing.bankAccountId
          : clean(input.bankAccountId);

      // Reverse the original recorded income.
      if (existing.bankAccountId) {
        await applyBalanceChange(tx, {
          businessId,
          accountId: existing.bankAccountId,
          amount: existing.amount,
          direction: "DECREMENT",
          date,
          incomeId,
          description: "Income edit: reverse previous amount",
        });
      }

      // Apply the corrected income to the selected account.
      if (bankAccountId) {
        await applyBalanceChange(tx, {
          businessId,
          accountId: bankAccountId,
          amount,
          direction: "INCREMENT",
          date,
          incomeId,
          description: "Income edit: apply corrected amount",
        });
      }

      return tx.otherIncome.update({
        where: { id: existing.id },
        data: {
          amount,
          date,
          bankAccountId,
          ...(input.category !== undefined
            ? { category: clean(input.category) }
            : {}),
          ...(input.paymentMethod !== undefined
            ? { paymentMethod: input.paymentMethod.trim() }
            : {}),
          ...(input.description !== undefined
            ? { description: clean(input.description) }
            : {}),
          ...(input.notes !== undefined ? { notes: clean(input.notes) } : {}),
          ...(input.reference !== undefined
            ? { reference: clean(input.reference) }
            : {}),
        },
        include: {
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

export async function deleteOtherIncome(businessId: string, incomeId: string) {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.otherIncome.findFirst({
        where: { id: incomeId, businessId },
      });

      if (!existing) {
        throw new AppError("Income record not found", 404);
      }

      if (existing.bankAccountId) {
        await applyBalanceChange(tx, {
          businessId,
          accountId: existing.bankAccountId,
          amount: existing.amount,
          direction: "DECREMENT",
          date: new Date(),
          incomeId,
          description: "Income deleted: reverse recorded amount",
        });
      }

      await tx.otherIncome.delete({
        where: { id: existing.id },
      });

      return {
        id: existing.id,
        deleted: true,
        message: "Income deleted and account balance adjusted",
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}
