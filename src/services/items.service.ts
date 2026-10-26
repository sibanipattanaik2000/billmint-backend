import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../utils/money";

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  return normalized.length > 0 ? normalized : null;
}

function validateImei(imei: string | null): void {
  if (!imei) {
    throw new AppError("IMEI number is required for serialized items", 400);
  }

  if (!/^\d{15}$/.test(imei)) {
    throw new AppError("IMEI number must contain exactly 15 digits", 400);
  }
}

function handleItemUniqueError(error: unknown): never {
  const prismaError = error as {
    code?: string;
    meta?: {
      target?: string[] | string;
    };
  };

  if (prismaError?.code === "P2002") {
    const target = Array.isArray(prismaError.meta?.target)
      ? prismaError.meta.target.join(", ")
      : String(prismaError.meta?.target ?? "");

    if (target.includes("sku")) {
      throw new AppError(
        "This Item Code already exists for this business",
        409,
      );
    }

    if (target.includes("barcode")) {
      throw new AppError("This barcode already exists for this business", 409);
    }

    if (target.includes("imei")) {
      throw new AppError("This IMEI already exists for this business", 409);
    }

    throw new AppError(
      "An item with one of these identifiers already exists",
      409,
    );
  }

  throw error;
}

/* =========================================================
    LIST ITEMS
  ========================================================= */

export async function listItems(
  businessId: string,
  opts: {
    page?: number;
    limit?: number;
    search?: string;
    categoryId?: string;
    lowStock?: boolean;
  },
) {
  const page = Math.max(1, Number(opts.page) || 1);

  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 20));

  const skip = (page - 1) * limit;

  const where: any = {
    businessId,
    deletedAt: null,
    status: "ACTIVE",
  };

  if (opts.categoryId) {
    where.categoryId = opts.categoryId;
  }

  if (opts.search?.trim()) {
    const search = opts.search.trim();

    where.OR = [
      {
        name: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        sku: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        barcode: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        imei: {
          contains: search,
        },
      },
      {
        hsnSac: {
          contains: search,
          mode: "insensitive",
        },
      },
    ];
  }

  /*
   * We intentionally do not use a Prisma field reference
   * for low-stock filtering here.
   *
   * currentStock <= minimumStock is better handled with
   * a dedicated query/index strategy when reporting scale
   * becomes important.
   */
  if (opts.lowStock) {
    where.AND = [
      {
        currentStock: {
          lte: 0,
        },
      },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.item.findMany({
      where,

      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },

        brand: {
          select: {
            id: true,
            name: true,
          },
        },

        unit: {
          select: {
            id: true,
            name: true,
            shortName: true,
          },
        },

        supplier: {
          select: {
            id: true,
            name: true,
          },
        },
      },

      orderBy: [
        {
          name: "asc",
        },
        {
          id: "asc",
        },
      ],

      skip,
      take: limit,
    }),

    prisma.item.count({
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

/* =========================================================
    GET ITEM
  ========================================================= */

export async function getItem(businessId: string, id: string) {
  const item = await prisma.item.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },

    include: {
      category: true,
      brand: true,

      unit: true,

      supplier: {
        select: {
          id: true,
          name: true,
        },
      },

      stockMovements: {
        orderBy: [
          {
            date: "desc",
          },
          {
            id: "desc",
          },
        ],

        take: 50,
      },
    },
  });

  if (!item) {
    throw new AppError("Item not found", 404);
  }

  return item;
}

/* =========================================================
    CREATE ITEM
  ========================================================= */

export async function createItem(
  businessId: string,
  data: any,
  userId?: string,
) {
  if (typeof data.name !== "string" || !data.name.trim()) {
    throw new AppError("Item name is required", 400);
  }

  const openingStock = toDecimal(data.openingStock ?? 0);

  if (openingStock.lt(0)) {
    throw new AppError("Opening stock cannot be negative", 400);
  }

  const sku = normalizeOptionalString(data.sku);

  const barcode = normalizeOptionalString(data.barcode);

  const imei = normalizeOptionalString(data.imei);

  const trackSerial = Boolean(data.trackSerial);

  if (trackSerial) {
    validateImei(imei);

    /*
     * One Item represents one physical serialized
     * device in the current BillMint inventory model.
     */
    if (openingStock.gt(1)) {
      throw new AppError(
        "A serialized item can have maximum opening stock of 1",
        400,
      );
    }
  }

  if (!trackSerial && imei) {
    throw new AppError(
      "An IMEI can only be assigned when serial tracking is enabled",
      400,
    );
  }

  try {
    const item = await prisma.$transaction(async (tx) => {
      /*
       * The database unique constraints are the final
       * concurrency protection. This pre-check only gives
       * the user a nicer error before attempting the insert.
       */


            const sourceStoreCode =
        normalizeOptionalString(data.sourceStoreCode)?.toUpperCase() || null;

      if (sourceStoreCode) {
        const sourceStore = await tx.business.findFirst({
          where: {
            storeCode: sourceStoreCode,
            deletedAt: null,
          },
          select: { storeCode: true },
        });

        if (!sourceStore) {
          throw new AppError("Source Store Code does not exist", 400);
        }
      }
      const existing = await tx.item.findFirst({
        where: {
          businessId,
          deletedAt: null,

          OR: [
            ...(sku ? [{ sku }] : []),

            ...(barcode ? [{ barcode }] : []),

            ...(imei ? [{ imei }] : []),
          ],
        },

        select: {
          id: true,
          sku: true,
          barcode: true,
          imei: true,
        },
      });

      if (existing) {
        if (sku && existing.sku === sku) {
          throw new AppError(`Item Code "${sku}" already exists`, 409);
        }

        if (barcode && existing.barcode === barcode) {
          throw new AppError(`Barcode "${barcode}" already exists`, 409);
        }

        if (imei && existing.imei === imei) {
          throw new AppError(`IMEI "${imei}" already exists`, 409);
        }

        throw new AppError(
          "An item with one of these identifiers already exists",
          409,
        );
      }

      const created = await tx.item.create({
        data: {
          businessId,
          sourceStoreCode,
          name: data.name.trim(),
          modelName:
            normalizeOptionalString(data.modelName) || data.name.trim(),
          deviceCode: normalizeOptionalString(data.deviceCode),
          sku,
          barcode,
          imei,

          categoryId: data.categoryId || null,

          brandId: data.brandId || null,

          unitId: data.unitId || null,

          description: normalizeOptionalString(data.description),

          purchasePrice: toDecimal(data.purchasePrice ?? 0) as any,

          salePrice: toDecimal(data.salePrice ?? 0) as any,

          mrp: data.mrp != null ? (toDecimal(data.mrp) as any) : null,

          openingStock: openingStock as any,

          currentStock: openingStock as any,

          minimumStock: toDecimal(data.minimumStock ?? 0) as any,

          gstRate: toDecimal(data.gstRate ?? 18) as any,

          hsnSac: normalizeOptionalString(data.hsnSac),

          discountPercent: toDecimal(data.discountPercent ?? 0) as any,

          supplierId: data.supplierId || null,

          trackBatch: Boolean(data.trackBatch),

          trackSerial,

          trackExpiry: Boolean(data.trackExpiry),
        },
      });
      if (trackSerial && imei) {
        await tx.inventoryUnit.create({
          data: {
            businessId,
            itemId: created.id,
            itemCode: normalizeOptionalString(data.deviceCode) || sku,
            imei,
            status: "AVAILABLE",
            purchasePrice: toDecimal(data.purchasePrice ?? 0) as any,
          },
        });
      }
      if (openingStock.gt(0)) {
        await tx.stockMovement.create({
          data: {
            businessId,

            itemId: created.id,

            type: "OPENING",

            quantityIn: openingStock as any,

            quantityOut: toDecimal(0) as any,

            balance: openingStock as any,

            notes: "Opening stock",
          },
        });
      }

      await tx.auditLog.create({
        data: {
          businessId,

          userId: userId || null,

          action: "CREATE",

          module: "items",

          recordId: created.id,

          recordName: created.name,

          details: JSON.stringify({
            sku,
            barcode,
            imei,
            trackSerial,
            openingStock: openingStock.toString(),
          }),
        },
      });

      return created;
    });

    return item;
  } catch (error) {
    handleItemUniqueError(error);
  }
}

/* =========================================================
    UPDATE ITEM
  ========================================================= */

export async function updateItem(
  businessId: string,
  id: string,
  data: any,
  userId?: string,
) {
  const existing = await prisma.item.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },
  });

  if (!existing) {
    throw new AppError("Item not found", 404);
  }

  const sku =
    data.sku !== undefined ? normalizeOptionalString(data.sku) : existing.sku;

  const barcode =
    data.barcode !== undefined
      ? normalizeOptionalString(data.barcode)
      : existing.barcode;

  const imei =
    data.imei !== undefined
      ? normalizeOptionalString(data.imei)
      : existing.imei;

  const trackSerial =
    data.trackSerial !== undefined
      ? Boolean(data.trackSerial)
      : existing.trackSerial;

  if (trackSerial) {
    validateImei(imei);
  }

  if (!trackSerial && imei) {
    throw new AppError(
      "An IMEI can only be assigned when serial tracking is enabled",
      400,
    );
  }

  /*
   * Do not allow a serialized item to be converted into
   * a non-serialized item while its IMEI still exists.
   */
  if (existing.trackSerial && !trackSerial && existing.currentStock.gt(0)) {
    throw new AppError(
      "A serialized item with available stock cannot disable serial tracking",
      400,
    );
  }

  try {
    const item = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.item.findFirst({
        where: {
          businessId,
          deletedAt: null,

          id: {
            not: id,
          },

          OR: [
            ...(sku ? [{ sku }] : []),

            ...(barcode ? [{ barcode }] : []),

            ...(imei ? [{ imei }] : []),
          ],
        },

        select: {
          id: true,
          sku: true,
          barcode: true,
          imei: true,
        },
      });

      if (duplicate) {
        if (sku && duplicate.sku === sku) {
          throw new AppError(`Item Code "${sku}" already exists`, 409);
        }

        if (barcode && duplicate.barcode === barcode) {
          throw new AppError(`Barcode "${barcode}" already exists`, 409);
        }

        if (imei && duplicate.imei === imei) {
          throw new AppError(`IMEI "${imei}" already exists`, 409);
        }

        throw new AppError(
          "Another item already uses one of these identifiers",
          409,
        );
      }

      const updated = await tx.item.update({
        where: {
          id,
        },

        data: {
          name: data.name !== undefined ? data.name.trim() : existing.name,

          sku,
          barcode,
          imei,

          categoryId:
            data.categoryId !== undefined
              ? data.categoryId
              : existing.categoryId,

          brandId: data.brandId !== undefined ? data.brandId : existing.brandId,

          unitId: data.unitId !== undefined ? data.unitId : existing.unitId,

          description:
            data.description !== undefined
              ? normalizeOptionalString(data.description)
              : existing.description,

          purchasePrice:
            data.purchasePrice !== undefined
              ? (toDecimal(data.purchasePrice) as any)
              : existing.purchasePrice,

          salePrice:
            data.salePrice !== undefined
              ? (toDecimal(data.salePrice) as any)
              : existing.salePrice,
          modelName:
            data.modelName !== undefined
              ? normalizeOptionalString(data.modelName) ||
                (data.name !== undefined ? data.name.trim() : existing.name)
              : existing.modelName,

          deviceCode:
            data.deviceCode !== undefined
              ? normalizeOptionalString(data.deviceCode)
              : existing.deviceCode,
          mrp:
            data.mrp !== undefined
              ? data.mrp != null
                ? (toDecimal(data.mrp) as any)
                : null
              : existing.mrp,

          minimumStock:
            data.minimumStock !== undefined
              ? (toDecimal(data.minimumStock) as any)
              : existing.minimumStock,

          gstRate:
            data.gstRate !== undefined
              ? (toDecimal(data.gstRate) as any)
              : existing.gstRate,

          hsnSac:
            data.hsnSac !== undefined
              ? normalizeOptionalString(data.hsnSac)
              : existing.hsnSac,

          discountPercent:
            data.discountPercent !== undefined
              ? (toDecimal(data.discountPercent) as any)
              : existing.discountPercent,

          supplierId:
            data.supplierId !== undefined
              ? data.supplierId
              : existing.supplierId,

          trackBatch:
            data.trackBatch !== undefined
              ? Boolean(data.trackBatch)
              : existing.trackBatch,

          trackSerial,

          trackExpiry:
            data.trackExpiry !== undefined
              ? Boolean(data.trackExpiry)
              : existing.trackExpiry,
        },
      });

      await tx.auditLog.create({
        data: {
          businessId,

          userId: userId || null,

          action: "UPDATE",

          module: "items",

          recordId: id,

          recordName: updated.name,

          details: JSON.stringify({
            sku,
            barcode,
            imei,
            trackSerial,
          }),
        },
      });

      return updated;
    });

    return item;
  } catch (error) {
    handleItemUniqueError(error);
  }
}

/* =========================================================
    DELETE / ARCHIVE ITEM
  ========================================================= */

export async function deleteItem(
  businessId: string,
  id: string,
  userId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.item.findFirst({
      where: {
        id,
        businessId,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            purchaseItems: true,
            saleItems: true,
            purchaseReturnItems: true,
            saleReturnItems: true,
            quotationItems: true,
            challanItems: true,
            stockAdjustments: true,
            shelfStocks: true,
            shelfMovements: true,
          },
        },
        inventoryUnits: {
          select: {
            id: true,
            purchaseId: true,
            purchaseItemId: true,
            saleId: true,
            saleItemId: true,
          },
        },
      },
    });

    if (!existing) {
      throw new AppError("Item not found", 404);
    }

    const references = existing._count;
    const hasTransactions =
      references.purchaseItems > 0 ||
      references.saleItems > 0 ||
      references.purchaseReturnItems > 0 ||
      references.saleReturnItems > 0 ||
      references.quotationItems > 0 ||
      references.challanItems > 0 ||
      references.stockAdjustments > 0 ||
      references.shelfStocks > 0 ||
      references.shelfMovements > 0;

    if (hasTransactions) {
      throw new AppError(
        "This item is linked to existing transactions or shelf records and cannot be permanently deleted. Preserve its history and archive it instead.",
        409,
      );
    }

    const hasPurchasedOrSoldUnits = existing.inventoryUnits.some(
      (unit) =>
        unit.purchaseId !== null ||
        unit.purchaseItemId !== null ||
        unit.saleId !== null ||
        unit.saleItemId !== null,
    );

    if (hasPurchasedOrSoldUnits) {
      throw new AppError(
        "This item has inventory units linked to purchases or sales and cannot be permanently deleted.",
        409,
      );
    }

    // Safe only after confirming the item has no transaction references.
    await tx.inventoryUnit.deleteMany({
      where: {
        businessId,
        itemId: id,
      },
    });

    // Remove the item's standalone stock movements, including opening stock.
    await tx.stockMovement.deleteMany({
      where: {
        businessId,
        itemId: id,
      },
    });

    await tx.auditLog.create({
      data: {
        businessId,
        userId: userId || null,
        action: "DELETE",
        module: "items",
        recordId: id,
        recordName: existing.name,
        details: JSON.stringify({
          permanent: true,
          reason: "User deleted an unused item",
        }),
      },
    });

    await tx.item.delete({
      where: {
        id,
      },
    });

    return {
      message: "Item deleted successfully",
      id,
    };
  });
}

/* =========================================================
    BARCODE SEARCH
  ========================================================= */

export async function searchByBarcode(businessId: string, barcode: string) {
  const normalized = barcode.trim();

  if (!normalized) {
    throw new AppError("Barcode is required", 400);
  }

  const item = await prisma.item.findFirst({
    where: {
      businessId,

      barcode: normalized,

      deletedAt: null,

      status: "ACTIVE",
    },

    include: {
      unit: {
        select: {
          id: true,
          name: true,
          shortName: true,
        },
      },

      category: {
        select: {
          id: true,
          name: true,
        },
      },

      brand: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!item) {
    throw new AppError("Item not found for barcode", 404);
  }

  return item;
}

/* =========================================================
    ITEM CODE / SKU SEARCH
  ========================================================= */

export async function searchBySku(businessId: string, sku: string) {
  const normalizedSku = sku.trim();

  if (!normalizedSku) {
    throw new AppError("Item Code is required", 400);
  }

  /*
   * First look for an exact physical-device Item Code.
   * This ensures that the correct device and IMEI are selected.
   */
  const inventoryUnit = await prisma.inventoryUnit.findFirst({
    where: {
      businessId,
      itemCode: normalizedSku,
    },
    include: {
      item: {
        include: {
          category: true,
          brand: true,
          unit: true,
          supplier: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (inventoryUnit) {
    if (
      inventoryUnit.status !== "AVAILABLE" &&
      inventoryUnit.status !== "RETURNED"
    ) {
      throw new AppError(
        `This Item Code is not available for sale (status: ${inventoryUnit.status})`,
        409,
      );
    }

    if (
      inventoryUnit.item.deletedAt !== null ||
      inventoryUnit.item.status !== "ACTIVE"
    ) {
      throw new AppError(
        "The item associated with this Item Code is inactive",
        409,
      );
    }

    return {
      ...inventoryUnit.item,
      itemCode: inventoryUnit.itemCode,
      inventoryUnit: {
        id: inventoryUnit.id,
        itemCode: inventoryUnit.itemCode,
        imei: inventoryUnit.imei,
        serialNumber: inventoryUnit.serialNumber,
        status: inventoryUnit.status,
        purchasePrice: inventoryUnit.purchasePrice,
      },
      stockAvailable: true,
    };
  }

  /*
   * Backward compatibility:
   * also support regular item SKU and device code lookup.
   * Return the first available physical unit for a
   * serial-tracked item so its IMEI can populate the sale.
   */
  const item = await prisma.item.findFirst({
    where: {
      businessId,
      OR: [{ sku: normalizedSku }, { deviceCode: normalizedSku }],
      deletedAt: null,
      status: "ACTIVE",
    },
    include: {
      category: true,
      brand: true,
      unit: true,
      supplier: {
        select: {
          id: true,
          name: true,
        },
      },
      inventoryUnits: {
        where: {
          status: {
            in: ["AVAILABLE", "RETURNED"],
          },
        },
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          itemCode: true,
          imei: true,
          serialNumber: true,
          status: true,
          purchasePrice: true,
        },
      },
    },
  });

  if (!item) {
    throw new AppError(`Item Code "${normalizedSku}" not found`, 404);
  }

  const availableUnit = item.inventoryUnits[0] ?? null;

  return {
    ...item,
    itemCode: item.deviceCode || item.sku || normalizedSku,
    inventoryUnit: availableUnit,
    availableInventoryUnits: item.inventoryUnits.length,
    stockAvailable: item.trackSerial
      ? Boolean(availableUnit)
      : Number(item.currentStock) > 0,
    legacyImei: item.imei,
  };
}

/* =========================================================
    IMEI SEARCH
  ========================================================= */

export async function searchByImei(businessId: string, imei: string) {
  const normalizedImei = imei.trim();

  if (!/^\d{15}$/.test(normalizedImei)) {
    throw new AppError("IMEI must contain exactly 15 digits", 400);
  }

  // First, locate this exact physical device.
  const inventoryUnit = await prisma.inventoryUnit.findFirst({
    where: {
      businessId,
      imei: normalizedImei,
    },
    include: {
      item: {
        include: {
          category: true,
          brand: true,
          unit: true,
          supplier: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (inventoryUnit) {
    // Never allow reserved, sold, damaged, or lost
    // devices to be selected as available stock.
    if (
      inventoryUnit.status !== "AVAILABLE" &&
      inventoryUnit.status !== "RETURNED"
    ) {
      throw new AppError(
        `This IMEI is not available for sale (status: ${inventoryUnit.status})`,
        409,
      );
    }

    if (
      inventoryUnit.item.deletedAt !== null ||
      inventoryUnit.item.status !== "ACTIVE"
    ) {
      throw new AppError("The item associated with this IMEI is inactive", 409);
    }

    return {
      ...inventoryUnit.item,
      inventoryUnit: {
        id: inventoryUnit.id,
        imei: inventoryUnit.imei,
        serialNumber: inventoryUnit.serialNumber,
        status: inventoryUnit.status,
        purchasePrice: inventoryUnit.purchasePrice,
      },
      stockAvailable: true,
    };
  }

  // Backward compatibility for devices that still store
  // their IMEI directly on the Item record.
  const item = await prisma.item.findFirst({
    where: {
      businessId,
      imei: normalizedImei,
      deletedAt: null,
      status: "ACTIVE",
    },
    include: {
      category: true,
      brand: true,
      unit: true,
      supplier: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!item) {
    throw new AppError("No item or inventory device found for this IMEI", 404);
  }

  return {
    ...item,
    inventoryUnit: null,
    stockAvailable: true,
  };
}

/* =========================================================
    ADJUST STOCK
  ========================================================= */

export async function adjustStock(
  businessId: string,
  itemId: string,
  quantity: number,
  reason: string,
  notes?: string,
  userId?: string,
) {
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new AppError(
      "Stock adjustment quantity must be a non-zero number",
      400,
    );
  }

  if (typeof reason !== "string" || !reason.trim()) {
    throw new AppError("Adjustment reason is required", 400);
  }

  const qty = toDecimal(quantity);

  return prisma.$transaction(
    async (tx) => {
      const item = await tx.item.findFirst({
        where: {
          id: itemId,

          businessId,

          deletedAt: null,

          status: "ACTIVE",
        },

        select: {
          id: true,
          name: true,
          trackSerial: true,
          currentStock: true,
        },
      });

      if (!item) {
        throw new AppError("Item not found", 404);
      }

      /*
       * Serialized items represent one physical device.
       */
      if (
        item.trackSerial &&
        qty.gt(0) &&
        toDecimal(item.currentStock).plus(qty).gt(1)
      ) {
        throw new AppError(
          "Serialized items cannot have stock greater than 1",
          400,
        );
      }

      /*
       * Atomic conditional update.
       *
       * This prevents two simultaneous stock adjustments
       * from both reading the same old stock value.
       */
      const updated = qty.lt(0)
        ? await tx.item.updateMany({
            where: {
              id: item.id,

              businessId,

              deletedAt: null,

              status: "ACTIVE",

              currentStock: {
                gte: qty.abs() as any,
              },
            },

            data: {
              currentStock: {
                decrement: qty.abs() as any,
              },
            },
          })
        : await tx.item.updateMany({
            where: {
              id: item.id,

              businessId,

              deletedAt: null,

              status: "ACTIVE",
            },

            data: {
              currentStock: {
                increment: qty as any,
              },
            },
          });

      if (updated.count !== 1) {
        throw new AppError(
          "Stock changed while processing this adjustment. Please retry.",
          409,
        );
      }

      const updatedItem = await tx.item.findUnique({
        where: {
          id: item.id,
        },

        select: {
          id: true,
          name: true,
          currentStock: true,
        },
      });

      if (!updatedItem) {
        throw new AppError("Item no longer exists", 409);
      }
      const adjustment = await tx.stockAdjustment.create({
        data: {
          businessId,
          itemId: item.id,
          quantity: qty as any,
          reason: reason.trim(),
          notes: notes?.trim() || null,
          createdById: userId || null,
        },
      });
      await tx.stockMovement.create({
        data: {
          businessId,

          itemId: item.id,

          type: "ADJUSTMENT",

          quantityIn: qty.gt(0) ? (qty as any) : (toDecimal(0) as any),

          quantityOut: qty.lt(0) ? (qty.abs() as any) : (toDecimal(0) as any),

          balance: updatedItem.currentStock as any,

          referenceType: "stock_adjustment",

          referenceId: adjustment.id,
          notes: reason.trim(),
        },
      });

      await tx.auditLog.create({
        data: {
          businessId,

          userId: userId || null,

          action: "UPDATE",

          module: "inventory",

          recordId: item.id,

          recordName: item.name,

          details: JSON.stringify({
            type: "STOCK_ADJUSTMENT",

            quantity: qty.toString(),

            balance: updatedItem.currentStock.toString(),

            reason: reason.trim(),
          }),
        },
      });

      return updatedItem;
    },
    {
      isolationLevel: "Serializable" as any,

      maxWait: 10_000,

      timeout: 20_000,
    },
  );
}

/* =========================================================
   MODEL-GROUPED INVENTORY
   Used by the All Items model view.
========================================================= */

export async function listItemModels(businessId: string) {
  const items = await prisma.item.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: "ACTIVE",
    },
    include: {
      category: {
        select: { id: true, name: true },
      },
      brand: {
        select: { id: true, name: true },
      },
      unit: {
        select: { id: true, name: true, shortName: true },
      },
      inventoryUnits: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          itemCode: true,
          imei: true,
          serialNumber: true,
          status: true,
          purchasePrice: true,
        },
      },
    },
    orderBy: [{ modelName: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  const groups = new Map<
    string,
    {
      modelName: string;
      totalStock: number;
      items: typeof items;
    }
  >();

  for (const item of items) {
    // Exact model names stay separate. Legacy records fall back to name.
    const modelName = item.modelName?.trim() || item.name.trim();

    const group = groups.get(modelName);

    if (group) {
      group.totalStock += Number(item.currentStock ?? 0);
      group.items.push(item);
    } else {
      groups.set(modelName, {
        modelName,
        totalStock: Number(item.currentStock ?? 0),
        items: [item],
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.modelName.localeCompare(b.modelName),
  );
}

/* =========================================================
    LIST STOCK ADJUSTMENTS
  ========================================================= */

export async function listStockAdjustments(
  businessId: string,
  page = 1,
  limit = 20,
  itemId?: string,
) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 20));

  const where = {
    businessId,
    ...(itemId ? { itemId } : {}),
  };

  const [data, total] = await prisma.$transaction([
    prisma.stockAdjustment.findMany({
      where,
      include: {
        item: {
          select: {
            id: true,
            name: true,
            sku: true,
            currentStock: true,
          },
        },
      },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.stockAdjustment.count({ where }),
  ]);

  return {
    data,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
}
