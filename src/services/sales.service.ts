import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { calculateLineItem, calculateInvoiceTotals, toDecimal, roundMoney } from '../utils/money';
import { Decimal } from '../utils/money';

interface SaleItemInput {
  itemId?: string | null;
  itemName: string;
  hsnSac?: string;
  quantity: number;
  unit?: string;
  rate: number;
  discountPercent?: number;
  gstRate?: number;
}

interface CreateSaleInput {
  customerId?: string | null;
  date?: Date;
  dueDate?: Date | null;
  placeOfSupply?: string;
  items: SaleItemInput[];
  paymentMethod?: string;
  paidAmount?: number;
  notes?: string;
  terms?: string;
  status?: string;
  createdById?: string;
}

async function getNextInvoiceNumber(businessId: string, tx: any): Promise<string> {
  const seq = await tx.invoiceSequence.findUnique({
    where: { businessId_type: { businessId, type: 'invoice' } },
  });
  if (!seq) throw new AppError('Invoice sequence not configured', 500);

  const number = `${seq.prefix}-${String(seq.nextNumber).padStart(6, '0')}`;
  await tx.invoiceSequence.update({
    where: { id: seq.id },
    data: { nextNumber: seq.nextNumber + 1 },
  });
  return number;
}

export async function createSale(businessId: string, input: CreateSaleInput) {
  // Load business for state comparison
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new AppError('Business not found', 404);

  let customerState: string | null = null;
  if (input.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: input.customerId, businessId, deletedAt: null },
    });
    if (!customer) throw new AppError('Customer not found', 404);
    customerState = customer.state;
  }

  const isInterState =
    !!(business.state && customerState && business.state.toLowerCase() !== customerState.toLowerCase());

  // Validate items and stock
  const lineCalcs = [];
  const itemUpdates: { id: string; qty: Decimal }[] = [];

  for (const item of input.items) {
    if (item.itemId) {
      const dbItem = await prisma.item.findFirst({
        where: { id: item.itemId, businessId, deletedAt: null, status: 'ACTIVE' },
      });
      if (!dbItem) throw new AppError(`Item not found: ${item.itemName}`, 404);

      const qty = toDecimal(item.quantity);
      if (dbItem.currentStock.lessThan(qty)) {
        throw new AppError(
          `Insufficient stock for "${dbItem.name}". Available: ${dbItem.currentStock}, Requested: ${qty}`,
          400
        );
      }
      itemUpdates.push({ id: dbItem.id, qty });

      // Use item defaults if not provided
      if (!item.gstRate && item.gstRate !== 0) item.gstRate = Number(dbItem.gstRate);
      if (!item.hsnSac) item.hsnSac = dbItem.hsnSac || undefined;
      if (!item.unit) {
        const unit = dbItem.unitId
          ? await prisma.unit.findUnique({ where: { id: dbItem.unitId } })
          : null;
        item.unit = unit?.shortName || undefined;
      }
    }

    const calc = calculateLineItem({
      quantity: item.quantity,
      rate: item.rate,
      discountPercent: item.discountPercent || 0,
      gstRate: item.gstRate || 0,
      isInterState,
    });
    lineCalcs.push({ ...calc, itemId: item.itemId, itemName: item.itemName, hsnSac: item.hsnSac, unit: item.unit });
  }

  const totals = calculateInvoiceTotals(lineCalcs);
  const paidAmount = toDecimal(input.paidAmount || 0);
  const balanceAmount = roundMoney(totals.grandTotal.minus(paidAmount));

  let status = input.status || 'UNPAID';
  if (status !== 'DRAFT') {
    if (paidAmount.gte(totals.grandTotal) && totals.grandTotal.gt(0)) status = 'PAID';
    else if (paidAmount.gt(0)) status = 'PARTIALLY_PAID';
    else status = 'UNPAID';
  }

  const sale = await prisma.$transaction(async (tx) => {
    const invoiceNumber = await getNextInvoiceNumber(businessId, tx);

    const created = await tx.sale.create({
      data: {
        businessId,
        invoiceNumber,
        customerId: input.customerId || null,
        date: input.date || new Date(),
        dueDate: input.dueDate || null,
        status: status as any,
        placeOfSupply: input.placeOfSupply || customerState || business.state,
        isInterState,
        subtotal: totals.subtotal as any,
        discountAmount: totals.discountAmount as any,
        taxableAmount: totals.taxableAmount as any,
        cgstAmount: totals.cgstAmount as any,
        sgstAmount: totals.sgstAmount as any,
        igstAmount: totals.igstAmount as any,
        cessAmount: totals.cessAmount as any,
        roundOff: totals.roundOff as any,
        grandTotal: totals.grandTotal as any,
        paidAmount: paidAmount as any,
        balanceAmount: balanceAmount as any,
        paymentMethod: input.paymentMethod || null,
        notes: input.notes || null,
        terms: input.terms || null,
        createdById: input.createdById || null,
        items: {
          create: lineCalcs.map((lc) => ({
            itemId: lc.itemId || null,
            itemName: lc.itemName,
            hsnSac: lc.hsnSac || null,
            quantity: lc.quantity as any,
            unit: lc.unit || null,
            rate: lc.rate as any,
            discountPercent: lc.discountPercent as any,
            discountAmount: lc.discountAmount as any,
            taxableAmount: lc.taxableAmount as any,
            gstRate: lc.gstRate as any,
            cgstAmount: lc.cgstAmount as any,
            sgstAmount: lc.sgstAmount as any,
            igstAmount: lc.igstAmount as any,
            amount: lc.amount as any,
          })),
        },
      },
      include: {
        items: true,
        customer: true,
      },
    });

    // Update stock & movements (skip for drafts)
    if (status !== 'DRAFT') {
      for (const upd of itemUpdates) {
        const item = await tx.item.update({
          where: { id: upd.id },
          data: { currentStock: { decrement: upd.qty as any } },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            itemId: upd.id,
            type: 'SALE',
            quantityOut: upd.qty as any,
            balance: item.currentStock as any,
            referenceType: 'sale',
            referenceId: created.id,
          },
        });
      }

      // Update customer balance
      if (input.customerId && balanceAmount.gt(0)) {
        await tx.customer.update({
          where: { id: input.customerId },
          data: { currentBalance: { increment: balanceAmount as any } },
        });
      }

      // Record payment if paid
      if (paidAmount.gt(0)) {
        const payment = await tx.paymentIn.create({
          data: {
            businessId,
            customerId: input.customerId || null,
            amount: paidAmount as any,
            date: input.date || new Date(),
            paymentMethod: input.paymentMethod || 'cash',
            createdById: input.createdById || null,
            allocations: {
              create: [{ saleId: created.id, amount: paidAmount as any }],
            },
          },
        });

        // Update cash/bank if applicable
        if (input.paymentMethod === 'cash' || !input.paymentMethod) {
          const cashAccount = await tx.bankAccount.findFirst({
            where: { businessId, isCash: true },
          });
          if (cashAccount) {
            const newBal = toDecimal(cashAccount.currentBalance).plus(paidAmount);
            await tx.bankAccount.update({
              where: { id: cashAccount.id },
              data: { currentBalance: newBal as any },
            });
            await tx.bankTransaction.create({
              data: {
                businessId,
                bankAccountId: cashAccount.id,
                type: 'RECEIPT',
                amount: paidAmount as any,
                balance: newBal as any,
                referenceType: 'payment_in',
                referenceId: payment.id,
                description: `Payment for ${invoiceNumber}`,
              },
            });
          }
        }
      }
    }

    // Audit
    await tx.auditLog.create({
      data: {
        businessId,
        userId: input.createdById || null,
        action: 'CREATE',
        module: 'sales',
        recordId: created.id,
        recordName: invoiceNumber,
        details: JSON.stringify({ grandTotal: totals.grandTotal.toString(), status }),
      },
    });

    return created;
  });

  return sale;
}

export async function getSales(
  businessId: string,
  options: { page?: number; limit?: number; search?: string; status?: string; from?: Date; to?: Date }
) {
  const page = options.page || 1;
  const limit = options.limit || 20;
  const skip = (page - 1) * limit;

  const where: any = { businessId, deletedAt: null };
  if (options.status) where.status = options.status;
  if (options.from || options.to) {
    where.date = {};
    if (options.from) where.date.gte = options.from;
    if (options.to) where.date.lte = options.to;
  }
  if (options.search) {
    where.OR = [
      { invoiceNumber: { contains: options.search, mode: 'insensitive' } },
      { customer: { name: { contains: options.search, mode: 'insensitive' } } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        items: true,
      },
      orderBy: { date: 'desc' },
      skip,
      take: limit,
    }),
    prisma.sale.count({ where }),
  ]);

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getSaleById(businessId: string, id: string) {
  const sale = await prisma.sale.findFirst({
    where: { id, businessId, deletedAt: null },
    include: {
      customer: true,
      items: { include: { item: true } },
      payments: { include: { paymentIn: true } },
    },
  });
  if (!sale) throw new AppError('Sale not found', 404);
  return sale;
}

export async function cancelSale(businessId: string, id: string, userId?: string) {
  const sale = await prisma.sale.findFirst({
    where: { id, businessId, deletedAt: null },
    include: { items: true },
  });
  if (!sale) throw new AppError('Sale not found', 404);
  if (sale.status === 'CANCELLED') throw new AppError('Sale already cancelled', 400);

  await prisma.$transaction(async (tx) => {
    // Restore stock
    for (const si of sale.items) {
      if (si.itemId) {
        const item = await tx.item.update({
          where: { id: si.itemId },
          data: { currentStock: { increment: si.quantity as any } },
        });
        await tx.stockMovement.create({
          data: {
            businessId,
            itemId: si.itemId,
            type: 'SALE_RETURN',
            quantityIn: si.quantity as any,
            balance: item.currentStock as any,
            referenceType: 'sale_cancel',
            referenceId: sale.id,
            notes: 'Sale cancelled',
          },
        });
      }
    }

    // Reverse customer balance
    if (sale.customerId && toDecimal(sale.balanceAmount).gt(0)) {
      await tx.customer.update({
        where: { id: sale.customerId },
        data: { currentBalance: { decrement: sale.balanceAmount as any } },
      });
    }

    await tx.sale.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    await tx.auditLog.create({
      data: {
        businessId,
        userId: userId || null,
        action: 'CANCEL',
        module: 'sales',
        recordId: id,
        recordName: sale.invoiceNumber,
      },
    });
  });

  return { message: 'Sale cancelled successfully' };
}
