import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import { toDecimal } from '../utils/money';

export async function listItems(
  businessId: string,
  opts: { page?: number; limit?: number; search?: string; categoryId?: string; lowStock?: boolean }
) {
  const page = opts.page || 1;
  const limit = opts.limit || 20;
  const skip = (page - 1) * limit;

  const where: any = { businessId, deletedAt: null, status: 'ACTIVE' };
  if (opts.categoryId) where.categoryId = opts.categoryId;
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: 'insensitive' } },
      { sku: { contains: opts.search, mode: 'insensitive' } },
      { barcode: { contains: opts.search } },
      { hsnSac: { contains: opts.search } },
    ];
  }
  if (opts.lowStock) {
    where.AND = [{ currentStock: { lte: prisma.item.fields.minimumStock } }];
  }

  const [data, total] = await Promise.all([
    prisma.item.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        unit: { select: { id: true, name: true, shortName: true } },
      },
      orderBy: { name: 'asc' },
      skip,
      take: limit,
    }),
    prisma.item.count({ where }),
  ]);

  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getItem(businessId: string, id: string) {
  const item = await prisma.item.findFirst({
    where: { id, businessId, deletedAt: null },
    include: {
      category: true,
      brand: true,
      unit: true,
      supplier: { select: { id: true, name: true } },
      stockMovements: { orderBy: { date: 'desc' }, take: 50 },
    },
  });
  if (!item) throw new AppError('Item not found', 404);
  return item;
}

export async function createItem(businessId: string, data: any, userId?: string) {
  const openingStock = toDecimal(data.openingStock || 0);

  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        businessId,
        name: data.name,
        sku: data.sku || null,
        barcode: data.barcode || null,
        categoryId: data.categoryId || null,
        brandId: data.brandId || null,
        unitId: data.unitId || null,
        description: data.description || null,
        purchasePrice: toDecimal(data.purchasePrice || 0) as any,
        salePrice: toDecimal(data.salePrice || 0) as any,
        mrp: data.mrp != null ? (toDecimal(data.mrp) as any) : null,
        openingStock: openingStock as any,
        currentStock: openingStock as any,
        minimumStock: toDecimal(data.minimumStock || 0) as any,
        gstRate: toDecimal(data.gstRate ?? 18) as any,
        hsnSac: data.hsnSac || null,
        discountPercent: toDecimal(data.discountPercent || 0) as any,
        supplierId: data.supplierId || null,
        trackBatch: data.trackBatch || false,
        trackSerial: data.trackSerial || false,
        trackExpiry: data.trackExpiry || false,
      },
    });

    if (openingStock.gt(0)) {
      await tx.stockMovement.create({
        data: {
          businessId,
          itemId: created.id,
          type: 'OPENING',
          quantityIn: openingStock as any,
          balance: openingStock as any,
          notes: 'Opening stock',
        },
      });
    }

    await tx.auditLog.create({
      data: {
        businessId,
        userId: userId || null,
        action: 'CREATE',
        module: 'items',
        recordId: created.id,
        recordName: created.name,
      },
    });

    return created;
  });

  return item;
}

export async function updateItem(businessId: string, id: string, data: any, userId?: string) {
  const existing = await prisma.item.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!existing) throw new AppError('Item not found', 404);

  const item = await prisma.item.update({
    where: { id },
    data: {
      name: data.name ?? existing.name,
      sku: data.sku !== undefined ? data.sku || null : existing.sku,
      barcode: data.barcode !== undefined ? data.barcode || null : existing.barcode,
      categoryId: data.categoryId !== undefined ? data.categoryId : existing.categoryId,
      brandId: data.brandId !== undefined ? data.brandId : existing.brandId,
      unitId: data.unitId !== undefined ? data.unitId : existing.unitId,
      description: data.description !== undefined ? data.description || null : existing.description,
      purchasePrice: data.purchasePrice !== undefined ? (toDecimal(data.purchasePrice) as any) : existing.purchasePrice,
      salePrice: data.salePrice !== undefined ? (toDecimal(data.salePrice) as any) : existing.salePrice,
      mrp: data.mrp !== undefined ? (data.mrp != null ? toDecimal(data.mrp) as any : null) : existing.mrp,
      minimumStock: data.minimumStock !== undefined ? (toDecimal(data.minimumStock) as any) : existing.minimumStock,
      gstRate: data.gstRate !== undefined ? (toDecimal(data.gstRate) as any) : existing.gstRate,
      hsnSac: data.hsnSac !== undefined ? data.hsnSac || null : existing.hsnSac,
      discountPercent: data.discountPercent !== undefined ? (toDecimal(data.discountPercent) as any) : existing.discountPercent,
      supplierId: data.supplierId !== undefined ? data.supplierId : existing.supplierId,
    },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: userId || null,
      action: 'UPDATE',
      module: 'items',
      recordId: id,
      recordName: item.name,
    },
  });

  return item;
}

export async function deleteItem(businessId: string, id: string, userId?: string) {
  const existing = await prisma.item.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!existing) throw new AppError('Item not found', 404);

  await prisma.item.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'ARCHIVED' },
  });

  await prisma.auditLog.create({
    data: {
      businessId,
      userId: userId || null,
      action: 'DELETE',
      module: 'items',
      recordId: id,
      recordName: existing.name,
    },
  });

  return { message: 'Item archived successfully' };
}

export async function searchByBarcode(businessId: string, barcode: string) {
  const item = await prisma.item.findFirst({
    where: { businessId, barcode, deletedAt: null, status: 'ACTIVE' },
    include: {
      unit: { select: { shortName: true } },
      category: { select: { name: true } },
    },
  });
  if (!item) throw new AppError('Item not found for barcode', 404);
  return item;
}

export async function adjustStock(
  businessId: string,
  itemId: string,
  quantity: number,
  reason: string,
  notes?: string,
  userId?: string
) {
  const item = await prisma.item.findFirst({
    where: { id: itemId, businessId, deletedAt: null },
  });
  if (!item) throw new AppError('Item not found', 404);

  const qty = toDecimal(quantity);
  const newStock = toDecimal(item.currentStock).plus(qty);
  if (newStock.lt(0)) throw new AppError('Stock cannot go negative', 400);

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.item.update({
      where: { id: itemId },
      data: { currentStock: newStock as any },
    });

    await tx.stockAdjustment.create({
      data: {
        businessId,
        itemId,
        quantity: qty as any,
        reason,
        notes: notes || null,
        createdById: userId || null,
      },
    });

    await tx.stockMovement.create({
      data: {
        businessId,
        itemId,
        type: 'ADJUSTMENT',
        quantityIn: qty.gt(0) ? (qty as any) : (toDecimal(0) as any),
        quantityOut: qty.lt(0) ? (qty.abs() as any) : (toDecimal(0) as any),
        balance: newStock as any,
        notes: reason,
      },
    });

    return updated;
  });

  return result;
}
