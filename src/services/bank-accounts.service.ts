import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

export type CreateBankAccountInput = {
  name: string;
  accountNumber?: string | null;
  ifsc?: string | null;
  bankName?: string | null;
  branch?: string | null;
  openingBalance?: number;
  isCash?: boolean;
};

type ListBankAccountOptions = {
  search?: string;
  status?: "ACTIVE" | "ARCHIVED";
  page?: number;
  limit?: number;
};

function cleanOptional(value?: string | null): string | null {
  if (value == null) return null;
  const result = value.trim();
  return result || null;
}

function parseMoney(value: unknown): Prisma.Decimal {
  let amount: Prisma.Decimal;

  try {
    amount = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    throw new AppError("Opening balance must be a valid amount", 400);
  }

  if (!amount.isFinite() || amount.lt(0)) {
    throw new AppError("Opening balance cannot be negative", 400);
  }

  if (amount.decimalPlaces() > 2) {
    throw new AppError(
      "Opening balance cannot have more than two decimal places",
      400,
    );
  }

  return amount;
}

export async function listBankAccounts(
  businessId: string,
  options: ListBankAccountOptions = {},
) {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)));
  const search = options.search?.trim();

  const where: Prisma.BankAccountWhereInput = {
    businessId,
    ...(options.status ? { status: options.status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { bankName: { contains: search, mode: "insensitive" } },
            { accountNumber: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [data, total, balances] = await prisma.$transaction([
    prisma.bankAccount.findMany({
      where,
      select: {
        id: true,
        name: true,
        accountNumber: true,
        ifsc: true,
        bankName: true,
        branch: true,
        openingBalance: true,
        currentBalance: true,
        isCash: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isCash: "desc" }, { name: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bankAccount.count({ where }),
    prisma.bankAccount.aggregate({
      where: {
        businessId,
        status: "ACTIVE",
      },
      _sum: { currentBalance: true },
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
      totalActiveBalance: Number(balances._sum.currentBalance ?? 0),
    },
  };
}

export async function getBankAccount(
  businessId: string,
  accountId: string,
) {
  const account = await prisma.bankAccount.findFirst({
    where: {
      id: accountId,
      businessId,
    },
    select: {
      id: true,
      name: true,
      accountNumber: true,
      ifsc: true,
      bankName: true,
      branch: true,
      openingBalance: true,
      currentBalance: true,
      isCash: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!account) {
    throw new AppError("Cash/bank account not found", 404);
  }

  return account;
}

export async function createBankAccount(
  businessId: string,
  input: CreateBankAccountInput,
) {
  const name = input.name.trim().replace(/\s+/g, " ");

  if (!name) {
    throw new AppError("Account name is required", 400);
  }

  if (name.length > 150) {
    throw new AppError("Account name cannot exceed 150 characters", 400);
  }

  const accountNumber = cleanOptional(input.accountNumber);
  const ifsc = cleanOptional(input.ifsc)?.toUpperCase() ?? null;
  const bankName = cleanOptional(input.bankName);
  const branch = cleanOptional(input.branch);
  const openingBalance = parseMoney(input.openingBalance ?? 0);
  const isCash = input.isCash ?? false;

  if (accountNumber && accountNumber.length > 100) {
    throw new AppError("Account number cannot exceed 100 characters", 400);
  }

  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw new AppError("Invalid IFSC code", 400);
  }

  if (isCash && (accountNumber || ifsc || bankName || branch)) {
    throw new AppError(
      "Cash accounts cannot contain bank account details",
      400,
    );
  }

  return prisma.$transaction(
    async (tx) => {
      const duplicate = await tx.bankAccount.findFirst({
        where: {
          businessId,
          name: { equals: name, mode: "insensitive" },
        },
        select: { id: true },
      });

      if (duplicate) {
        throw new AppError(
          "An account with this name already exists",
          409,
        );
      }

      const account = await tx.bankAccount.create({
        data: {
          businessId,
          name,
          accountNumber,
          ifsc,
          bankName,
          branch,
          openingBalance,
          currentBalance: openingBalance,
          isCash,
        },
      });

      if (openingBalance.gt(0)) {
        await tx.bankTransaction.create({
          data: {
            businessId,
            bankAccountId: account.id,
            date: new Date(),
            type: "OPENING",
            amount: openingBalance,
            balance: openingBalance,
            referenceType: "OPENING_BALANCE",
            referenceId: account.id,
            description: "Opening balance",
          },
        });
      }

      return account;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}