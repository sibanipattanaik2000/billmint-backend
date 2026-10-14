import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export type CashBankStatementFilters = {
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
};

type StatementTransaction = {
  id: string;
  date: Date;
  type: string;
  amount: Prisma.Decimal;
  balance: Prisma.Decimal;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: Date;
};

function getTransactionMovement(
  transaction: StatementTransaction,
): number {
  const amount = Number(transaction.amount);

  switch (transaction.type) {
    case "OPENING":
    case "DEPOSIT":
    case "TRANSFER_IN":
    case "RECEIPT":
      return amount;

    case "WITHDRAWAL":
    case "TRANSFER_OUT":
    case "PAYMENT":
      return -amount;

    case "ADJUSTMENT":
      // Adjustment direction cannot be determined from the type alone.
      // The stored balance snapshot is handled separately below.
      return 0;

    default:
      return 0;
  }
}

export async function getCashBankStatement(
  businessId: string,
  accountId: string,
  filters: CashBankStatementFilters = {},
) {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(filters.limit ?? 50)));

  if (
    filters.from &&
    filters.to &&
    filters.from.getTime() > filters.to.getTime()
  ) {
    throw new AppError("'from' date cannot be later than 'to' date", 400);
  }

  const account = await prisma.bankAccount.findFirst({
    where: {
      id: accountId,
      businessId,
    },
    select: {
      id: true,
      name: true,
      isCash: true,
      openingBalance: true,
      currentBalance: true,
      status: true,
    },
  });

  if (!account) {
    throw new AppError("Cash/bank account not found", 404);
  }

  const baseWhere: Prisma.BankTransactionWhereInput = {
    businessId,
    bankAccountId: accountId,
  };

  const dateFilter: Prisma.BankTransactionWhereInput = {
    ...baseWhere,
    ...(filters.from || filters.to
      ? {
          date: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const [total, transactions] = await prisma.$transaction([
    prisma.bankTransaction.count({
      where: dateFilter,
    }),
    prisma.bankTransaction.findMany({
      where: dateFilter,
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        balance: true,
        referenceType: true,
        referenceId: true,
        description: true,
        createdAt: true,
      },
      orderBy: [
        { date: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const firstTransaction = transactions[0];

  let openingBalance = 0;

  if (firstTransaction) {
    const priorTransactions = await prisma.bankTransaction.findMany({
      where: {
        ...baseWhere,
        OR: [
          { date: { lt: firstTransaction.date } },
          {
            date: firstTransaction.date,
            createdAt: { lt: firstTransaction.createdAt },
          },
          {
            date: firstTransaction.date,
            createdAt: firstTransaction.createdAt,
            id: { lt: firstTransaction.id },
          },
        ],
      },
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        balance: true,
        referenceType: true,
        referenceId: true,
        description: true,
        createdAt: true,
      },
      orderBy: [
        { date: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    let runningBalance = 0;

    for (const transaction of priorTransactions) {
      if (transaction.type === "ADJUSTMENT") {
        // The adjustment's signed movement is not represented explicitly
        // by the transaction type. Do not guess its direction.
        runningBalance = Number(transaction.balance);
      } else {
        runningBalance += getTransactionMovement(
          transaction as StatementTransaction,
        );
      }
    }

    openingBalance = runningBalance;
  } else if (!filters.from && !filters.to && page === 1 && total === 0) {
    openingBalance = Number(account.openingBalance);
  } else if (filters.from) {
    const priorTransactions = await prisma.bankTransaction.findMany({
      where: {
        ...baseWhere,
        date: { lt: filters.from },
      },
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        balance: true,
        referenceType: true,
        referenceId: true,
        description: true,
        createdAt: true,
      },
      orderBy: [
        { date: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    let runningBalance = 0;

    for (const transaction of priorTransactions) {
      if (transaction.type === "ADJUSTMENT") {
        runningBalance = Number(transaction.balance);
      } else {
        runningBalance += getTransactionMovement(
          transaction as StatementTransaction,
        );
      }
    }

    openingBalance = runningBalance;
  }

  let runningBalance = openingBalance;

  const mappedTransactions = transactions.map((transaction) => {
    if (transaction.type === "ADJUSTMENT") {
      // Retain the recorded balance for adjustments until their signed
      // movement is defined by the adjustment-writing service.
      runningBalance = Number(transaction.balance);
    } else {
      runningBalance += getTransactionMovement(
        transaction as StatementTransaction,
      );
    }

    return {
      ...transaction,
      amount: Number(transaction.amount),
      balance: runningBalance,
    };
  });

  return {
    account,
    statement: {
      from: filters.from?.toISOString() ?? null,
      to: filters.to?.toISOString() ?? null,
      openingBalance,
      closingBalance:
        mappedTransactions.length > 0
          ? mappedTransactions[mappedTransactions.length - 1].balance
          : openingBalance,
      transactions: mappedTransactions,
    },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}