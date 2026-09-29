import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { toDecimal } from '../utils/money';

type CustomerStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

interface CustomerListOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return String(value);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError('Customer name is required', 400);
  }

  const name = value.trim();

  if (!name) {
    throw new AppError('Customer name is required', 400);
  }

  if (name.length > 200) {
    throw new AppError('Customer name cannot exceed 200 characters', 400);
  }

  return name;
}

function normalizeNonNegativeDecimal(
  value: unknown,
  fieldName: string
) {
  if (value === undefined || value === null || value === '') {
    return toDecimal(0);
  }

  const numberValue =
    typeof value === 'number'
      ? value
      : Number(value);

  if (!Number.isFinite(numberValue)) {
    throw new AppError(`${fieldName} must be a valid number`, 400);
  }

  if (numberValue < 0) {
    throw new AppError(`${fieldName} cannot be negative`, 400);
  }

  return toDecimal(numberValue);
}

function normalizeOptionalNonNegativeDecimal(
  value: unknown,
  fieldName: string
) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numberValue =
    typeof value === 'number'
      ? value
      : Number(value);

  if (!Number.isFinite(numberValue)) {
    throw new AppError(`${fieldName} must be a valid number`, 400);
  }

  if (numberValue < 0) {
    throw new AppError(`${fieldName} cannot be negative`, 400);
  }

  return toDecimal(numberValue);
}

function normalizePaymentTerms(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numberValue =
    typeof value === 'number'
      ? value
      : Number(value);

  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new AppError(
      'Payment terms must be a non-negative whole number',
      400
    );
  }

  return numberValue;
}

function normalizeStatus(status?: string): CustomerStatus | undefined {
  if (!status) {
    return undefined;
  }

  const normalized = status.toUpperCase();

  if (
    normalized !== 'ACTIVE' &&
    normalized !== 'INACTIVE' &&
    normalized !== 'ARCHIVED'
  ) {
    throw new AppError('Invalid customer status', 400);
  }

  return normalized;
}

export async function listCustomers(
  businessId: string,
  opts: CustomerListOptions
) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 20));
  const skip = (page - 1) * limit;

  const status = normalizeStatus(opts.status);

  const search =
    typeof opts.search === 'string'
      ? opts.search.trim()
      : '';

  const where: any = {
    businessId,
    deletedAt: null,
  };

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      {
        name: {
          contains: search,
          mode: 'insensitive',
        },
      },
      {
        phone: {
          contains: search,
        },
      },
      {
        email: {
          contains: search,
          mode: 'insensitive',
        },
      },
      {
        gstin: {
          contains: search,
          mode: 'insensitive',
        },
      },
      {
        businessName: {
          contains: search,
          mode: 'insensitive',
        },
      },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [
        { name: 'asc' },
        { id: 'asc' },
      ],
      skip,
      take: limit,
    }),

    prisma.customer.count({
      where,
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
  };
}

export async function getCustomer(
  businessId: string,
  id: string
) {
  const customer = await prisma.customer.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },

    include: {
      sales: {
        where: {
          deletedAt: null,
        },
        orderBy: {
          date: 'desc',
        },
        take: 20,
        select: {
          id: true,
          invoiceNumber: true,
          date: true,
          grandTotal: true,
          paidAmount: true,
          balanceAmount: true,
          status: true,
        },
      },

      paymentsIn: {
        orderBy: {
          date: 'desc',
        },
        take: 20,
      },
    },
  });

  if (!customer) {
    throw new AppError('Customer not found', 404);
  }

  return customer;
}

export async function createCustomer(
  businessId: string,
  data: any,
  userId?: string
) {
  const name = normalizeRequiredName(data.name);

  const openingBalance = normalizeNonNegativeDecimal(
    data.openingBalance,
    'Opening balance'
  );

  const creditLimit =
    data.creditLimit === undefined ||
    data.creditLimit === null ||
    data.creditLimit === ''
      ? null
      : normalizeOptionalNonNegativeDecimal(
          data.creditLimit,
          'Credit limit'
        );

  const paymentTerms = normalizePaymentTerms(
    data.paymentTerms
  );

  const customerData = {
    businessId,
    name,

    businessName: normalizeOptionalString(
      data.businessName
    ),

    phone: normalizeOptionalString(
      data.phone
    ),

    email: normalizeOptionalString(
      data.email
    ),

    address: normalizeOptionalString(
      data.address
    ),

    city: normalizeOptionalString(
      data.city
    ),

    state: normalizeOptionalString(
      data.state
    ),

    pinCode: normalizeOptionalString(
      data.pinCode
    ),

    gstin: normalizeOptionalString(
      data.gstin
    ),

    pan: normalizeOptionalString(
      data.pan
    ),

    openingBalance: openingBalance as any,

    currentBalance: openingBalance as any,

    creditLimit: creditLimit as any,

    paymentTerms,

    notes: normalizeOptionalString(
      data.notes
    ),
  };

  const result = await prisma.$transaction(
    async (tx) => {
      const customer = await tx.customer.create({
        data: customerData,
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId: userId || null,
          action: 'CREATE',
          module: 'customers',
          recordId: customer.id,
          recordName: customer.name,
          details: JSON.stringify({
            openingBalance: openingBalance.toString(),
            creditLimit:
              creditLimit?.toString() ?? null,
          }),
        },
      });

      return customer;
    },
    {
      timeout: 10000,
    }
  );

  return result;
}

export async function updateCustomer(
  businessId: string,
  id: string,
  data: any,
  userId?: string
) {
  const existing = await prisma.customer.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },
  });

  if (!existing) {
    throw new AppError('Customer not found', 404);
  }

  const updateData: any = {};

  if (data.name !== undefined) {
    updateData.name = normalizeRequiredName(data.name);
  }

  if (data.businessName !== undefined) {
    updateData.businessName =
      normalizeOptionalString(data.businessName);
  }

  if (data.phone !== undefined) {
    updateData.phone =
      normalizeOptionalString(data.phone);
  }

  if (data.email !== undefined) {
    updateData.email =
      normalizeOptionalString(data.email);
  }

  if (data.address !== undefined) {
    updateData.address =
      normalizeOptionalString(data.address);
  }

  if (data.city !== undefined) {
    updateData.city =
      normalizeOptionalString(data.city);
  }

  if (data.state !== undefined) {
    updateData.state =
      normalizeOptionalString(data.state);
  }

  if (data.pinCode !== undefined) {
    updateData.pinCode =
      normalizeOptionalString(data.pinCode);
  }

  if (data.gstin !== undefined) {
    updateData.gstin =
      normalizeOptionalString(data.gstin);
  }

  if (data.pan !== undefined) {
    updateData.pan =
      normalizeOptionalString(data.pan);
  }

  if (data.creditLimit !== undefined) {
    updateData.creditLimit =
      normalizeOptionalNonNegativeDecimal(
        data.creditLimit,
        'Credit limit'
      ) as any;
  }

  if (data.paymentTerms !== undefined) {
    updateData.paymentTerms =
      normalizePaymentTerms(data.paymentTerms);
  }

  if (data.notes !== undefined) {
    updateData.notes =
      normalizeOptionalString(data.notes);
  }

  /*
   * Opening balance is intentionally NOT updated here.
   *
   * Once a customer exists, changing opening balance directly
   * would alter accounting history. A proper opening-balance
   * adjustment should go through a dedicated accounting/
   * adjustment transaction.
   */

  if (Object.keys(updateData).length === 0) {
    return existing;
  }

  const result = await prisma.$transaction(
    async (tx) => {
      /*
       * Re-check the customer inside the transaction so that
       * an archived/deleted customer cannot accidentally be
       * updated after the initial lookup.
       */
      const current = await tx.customer.findFirst({
        where: {
          id,
          businessId,
          deletedAt: null,
        },
      });

      if (!current) {
        throw new AppError('Customer not found', 404);
      }

      const customer = await tx.customer.update({
        where: {
          id,
        },
        data: updateData,
      });

      await tx.auditLog.create({
        data: {
          businessId,
          userId: userId || null,
          action: 'UPDATE',
          module: 'customers',
          recordId: id,
          recordName: customer.name,
          details: JSON.stringify({
            fields: Object.keys(updateData),
          }),
        },
      });

      return customer;
    },
    {
      timeout: 10000,
    }
  );

  return result;
}

export async function deleteCustomer(
  businessId: string,
  id: string,
  userId?: string
) {
  const existing = await prisma.customer.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },
  });

  if (!existing) {
    throw new AppError('Customer not found', 404);
  }

  /*
   * Customers are archived rather than physically deleted
   * because sales, payments and accounting history may refer
   * to them.
   */
  const result = await prisma.$transaction(
    async (tx) => {
      const customer = await tx.customer.updateMany({
        where: {
          id,
          businessId,
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
          status: 'ARCHIVED',
        },
      });

      if (customer.count !== 1) {
        throw new AppError(
          'Customer was already archived or could not be found',
          409
        );
      }

      await tx.auditLog.create({
        data: {
          businessId,
          userId: userId || null,
          action: 'DELETE',
          module: 'customers',
          recordId: id,
          recordName: existing.name,
        },
      });

      return {
        message: 'Customer archived successfully',
      };
    },
    {
      timeout: 10000,
    }
  );

  return result;
}