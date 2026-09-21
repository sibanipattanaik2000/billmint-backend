import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { toDecimal } from '../utils/money';

export async function listCustomers(
  businessId: string,
  opts: { page?: number; limit?: number; search?: string; status?: string }
) {
  const page = opts.page || 1;
  const limit = opts.limit || 20;
  const skip = (page - 1) * limit;

  const where: any = { businessId, deletedAt: null };
  if (opts.status) where.status = opts.status;
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: 'insensitive' } },
      { phone: { contains: opts.search } },
      { email: { contains: opts.search, mode: 'insensitive' } },
      { gstin: { contains: opts.search, mode: 'insensitive' } },
      { businessName: { contains: opts.search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take: limit,
    }),
    prisma.customer.count({ where }),
  ]);

  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getCustomer(businessId: string, id: string) {
  const customer = await prisma.customer.findFirst({
    where: { id, businessId, deletedAt: null },
    include: {
      sales: {
        where: { deletedAt: null },
        orderBy: { date: 'desc' },
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
        orderBy: { date: 'desc' },
        take: 20,
      },
    },
  });
  if (!customer) throw new AppError('Customer not found', 404);
  return customer;
}

export async function createCustomer(businessId: string, data: any, userId?: string) {
  const customer = await prisma.customer.create({
    data: {
      businessId,
      name: data.name,
      businessName: data.businessName || null,
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      city: data.city || null,
      state: data.state || null,
      pinCode: data.pinCode || null,
      gstin: data.gstin || null,
      pan: data.pan || null,
      openingBalance: toDecimal(data.openingBalance || 0) as any,
      currentBalance: toDecimal(data.openingBalance || 0) as any,
      creditLimit: data.creditLimit != null ? (toDecimal(data.creditLimit) as any) : null,
      paymentTerms: data.paymentTerms ?? null,
      notes: data.notes || null,
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: userId || null,
      action: 'CREATE',
      module: 'customers',
      recordId: customer.id,
      recordName: customer.name,
    },
  });

  return customer;
}

export async function updateCustomer(businessId: string, id: string, data: any, userId?: string) {
  const existing = await prisma.customer.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!existing) throw new AppError('Customer not found', 404);

  const customer = await prisma.customer.update({
    where: { id },
    data: {
      name: data.name ?? existing.name,
      businessName: data.businessName !== undefined ? data.businessName || null : existing.businessName,
      phone: data.phone !== undefined ? data.phone || null : existing.phone,
      email: data.email !== undefined ? data.email || null : existing.email,
      address: data.address !== undefined ? data.address || null : existing.address,
      city: data.city !== undefined ? data.city || null : existing.city,
      state: data.state !== undefined ? data.state || null : existing.state,
      pinCode: data.pinCode !== undefined ? data.pinCode || null : existing.pinCode,
      gstin: data.gstin !== undefined ? data.gstin || null : existing.gstin,
      pan: data.pan !== undefined ? data.pan || null : existing.pan,
      creditLimit: data.creditLimit !== undefined ? (data.creditLimit != null ? toDecimal(data.creditLimit) as any : null) : existing.creditLimit,
      paymentTerms: data.paymentTerms !== undefined ? data.paymentTerms : existing.paymentTerms,
      notes: data.notes !== undefined ? data.notes || null : existing.notes,
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: userId || null,
      action: 'UPDATE',
      module: 'customers',
      recordId: id,
      recordName: customer.name,
    },
  });

  return customer;
}

export async function deleteCustomer(businessId: string, id: string, userId?: string) {
  const existing = await prisma.customer.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!existing) throw new AppError('Customer not found', 404);

  await prisma.customer.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'ARCHIVED' },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: userId || null,
      action: 'DELETE',
      module: 'customers',
      recordId: id,
      recordName: existing.name,
    },
  });

  return { message: 'Customer archived successfully' };
}
