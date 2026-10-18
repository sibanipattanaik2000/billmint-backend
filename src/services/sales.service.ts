import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  calculateLineItem,
  calculateInvoiceTotals,
  toDecimal,
  roundMoney,
} from "../utils/money";
import { Decimal } from "../utils/money";
import { Prisma } from "@prisma/client";

interface SaleItemInput {
  itemId?: string | null;
  itemName: string;
  hsnSac?: string;
  quantity: number;
  unit?: string;
  rate: number;
  discountPercent?: number;
  gstRate?: number;
  shelfId?: string | null;

  /*
   * For serialized / IMEI-tracked items.
   *
   * The frontend sends the exact physical inventory units
   * selected for this sale.
   */
  inventoryUnitIds?: string[];
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

type CalculatedSaleLine = ReturnType<typeof calculateLineItem> & {
  itemId: string | null;
  itemName: string;
  hsnSac?: string;
  unit?: string;

  inventoryUnitIds: string[];
};

type TransactionClient = Prisma.TransactionClient;

/* =========================================================
   INVOICE NUMBER
========================================================= */

async function getNextInvoiceNumber(
  businessId: string,
  tx: TransactionClient,
): Promise<string> {
  /*
   * Lock the sequence row so concurrent sales for the same
   * business cannot receive the same invoice number.
   */
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      prefix: string;
      nextNumber: number;
    }>
  >`
    SELECT
      "id",
      "prefix",
      "nextNumber"
    FROM "invoice_sequences"
    WHERE "businessId" = ${businessId}
      AND "type" = 'invoice'
    FOR UPDATE
  `;

  const seq = rows[0];

  if (!seq) {
    throw new AppError("Invoice sequence not configured", 500);
  }

  const invoiceNumber = `${seq.prefix}-${String(seq.nextNumber).padStart(6, "0")}`;

  await tx.invoiceSequence.update({
    where: {
      id: seq.id,
    },
    data: {
      nextNumber: {
        increment: 1,
      },
    },
  });

  return invoiceNumber;
}

/* =========================================================
   SERIALIZED INVENTORY VALIDATION
========================================================= */

function validateInventoryUnitIds(item: SaleItemInput): string[] {
  const ids = Array.isArray(item.inventoryUnitIds) ? item.inventoryUnitIds : [];

  const uniqueIds = new Set(ids);

  if (uniqueIds.size !== ids.length) {
    throw new AppError(
      `Duplicate inventory unit selected for "${item.itemName}"`,
      400,
    );
  }

  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) {
      throw new AppError(`Invalid inventory unit for "${item.itemName}"`, 400);
    }
  }

  return ids;
}

function assertSerializedQuantity(
  item: SaleItemInput,
  inventoryUnitIds: string[],
): void {
  if (inventoryUnitIds.length === 0) {
    return;
  }

  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    throw new AppError(
      `Serialized item "${item.itemName}" must have a whole-number quantity`,
      400,
    );
  }

  if (inventoryUnitIds.length !== item.quantity) {
    throw new AppError(
      `Select exactly ${item.quantity} IMEI/serial unit(s) for "${item.itemName}". Selected: ${inventoryUnitIds.length}`,
      400,
    );
  }
}

/* =========================================================
   CREATE SALE
========================================================= */

export async function createSale(businessId: string, input: CreateSaleInput) {
  if (!input.items || input.items.length === 0) {
    throw new AppError("At least one item is required", 400);
  }

  if (input.items.length > 100) {
    throw new AppError("A sale cannot contain more than 100 line items", 400);
  }

  const business = await prisma.business.findFirst({
    where: {
      id: businessId,
      deletedAt: null,
    },
    select: {
      id: true,
      state: true,
    },
  });

  if (!business) {
    throw new AppError("Business not found", 404);
  }

  return prisma.$transaction(
    async (tx) => {
      /* =====================================================
         CUSTOMER
      ===================================================== */

      let customerState: string | null = null;

      if (input.customerId) {
        const customer = await tx.customer.findFirst({
          where: {
            id: input.customerId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: {
            id: true,
            state: true,
          },
        });

        if (!customer) {
          throw new AppError("Customer not found", 404);
        }

        customerState = customer.state;
      }

      const isInterState = Boolean(
        business.state &&
        customerState &&
        business.state.toLowerCase() !== customerState.toLowerCase(),
      );

      /* =====================================================
         LOAD ITEMS
      ===================================================== */

      const itemIds = Array.from(
        new Set(
          input.items
            .map((item) => item.itemId)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      const dbItems =
        itemIds.length > 0
          ? await tx.item.findMany({
              where: {
                id: {
                  in: itemIds,
                },
                businessId,
                deletedAt: null,
                status: "ACTIVE",
              },
              select: {
                id: true,
                name: true,
                currentStock: true,
                gstRate: true,
                hsnSac: true,
                unitId: true,
                trackSerial: true,
              },
            })
          : [];

      const itemMap = new Map(dbItems.map((item) => [item.id, item]));

      /* =====================================================
         LINE CALCULATIONS
      ===================================================== */

      const lineCalcs: CalculatedSaleLine[] = [];

      /*
       * Aggregate requested stock by item.
       *
       * Example:
       * Item A qty 3
       * Item A qty 4
       *
       * Requested stock = 7
       *
       * This prevents duplicate invoice lines from bypassing
       * stock validation.
       */
      const requestedStock = new Map<string, Decimal>();
      const requestedShelfStock = new Map<string, Map<string, Decimal>>();

      const requestedShelfTotals = new Map<string, Decimal>();
      /*
       * Keep every serialized unit requested by this sale.
       *
       * Key = itemId
       * Value = exact physical inventory units.
       */
      const requestedInventoryUnits = new Map<string, string[]>();

      for (const item of input.items) {
        /* -------------------------------
           QUANTITY
        -------------------------------- */

        if (!Number.isFinite(item.quantity)) {
          throw new AppError(`Invalid quantity for "${item.itemName}"`, 400);
        }

        if (item.quantity <= 0) {
          throw new AppError(
            `Quantity must be greater than zero for "${item.itemName}"`,
            400,
          );
        }

        /* -------------------------------
           RATE
        -------------------------------- */

        if (!Number.isFinite(item.rate) || item.rate < 0) {
          throw new AppError(`Invalid rate for "${item.itemName}"`, 400);
        }

        /* -------------------------------
           DISCOUNT
        -------------------------------- */

        if (item.discountPercent !== undefined) {
          if (
            !Number.isFinite(item.discountPercent) ||
            item.discountPercent < 0 ||
            item.discountPercent > 100
          ) {
            throw new AppError(`Invalid discount for "${item.itemName}"`, 400);
          }
        }

        /* -------------------------------
           GST
        -------------------------------- */

        if (item.gstRate !== undefined) {
          if (
            !Number.isFinite(item.gstRate) ||
            item.gstRate < 0 ||
            item.gstRate > 100
          ) {
            throw new AppError(`Invalid GST rate for "${item.itemName}"`, 400);
          }
        }

        /* -------------------------------
           SERIALIZED UNITS
        -------------------------------- */

        const inventoryUnitIds = validateInventoryUnitIds(item);

        assertSerializedQuantity(item, inventoryUnitIds);

        /* ===================================================
           DATABASE ITEM
        =================================================== */

        if (item.itemId) {
          const dbItem = itemMap.get(item.itemId);

          if (!dbItem) {
            throw new AppError(`Item not found: ${item.itemName}`, 404);
          }

          /*
           * If the item is configured as serial tracked,
           * the sale must identify the exact physical units.
           *
           * We deliberately enforce this server-side so the
           * frontend cannot accidentally sell a serialized
           * product without selecting its IMEI/serial.
           */
          if (dbItem.trackSerial && inventoryUnitIds.length === 0) {
            throw new AppError(
              `Select the IMEI/serial unit(s) for "${dbItem.name}" before creating the sale`,
              400,
            );
          }

          /*
           * A non-serialized item must not receive physical
           * inventory unit IDs.
           */
          if (!dbItem.trackSerial && inventoryUnitIds.length > 0) {
            throw new AppError(
              `"${dbItem.name}" is not configured for serialized inventory`,
              400,
            );
          }

          const qty = toDecimal(item.quantity);

          const existing = requestedStock.get(dbItem.id) || toDecimal(0);

          requestedStock.set(dbItem.id, existing.plus(qty));
          if (item.shelfId) {
            const shelfQuantities =
              requestedShelfStock.get(dbItem.id) ?? new Map<string, Decimal>();

            const existingShelfQty =
              shelfQuantities.get(item.shelfId) ?? toDecimal(0);

            shelfQuantities.set(item.shelfId, existingShelfQty.plus(qty));

            requestedShelfStock.set(dbItem.id, shelfQuantities);

            requestedShelfTotals.set(
              dbItem.id,
              (requestedShelfTotals.get(dbItem.id) ?? toDecimal(0)).plus(qty),
            );
          }
          /*
           * Merge serialized units if the same item appears
           * on multiple invoice lines.
           */
          if (inventoryUnitIds.length > 0) {
            const existingUnits = requestedInventoryUnits.get(dbItem.id) || [];

            const merged = [...existingUnits, ...inventoryUnitIds];

            const uniqueMerged = new Set(merged);

            if (uniqueMerged.size !== merged.length) {
              throw new AppError(
                `The same IMEI/serial unit cannot be selected more than once for "${dbItem.name}"`,
                400,
              );
            }

            requestedInventoryUnits.set(dbItem.id, merged);
          }

          /*
           * Use database GST when frontend did not provide it.
           */
          if (item.gstRate === undefined) {
            item.gstRate = Number(dbItem.gstRate);
          }

          /*
           * Use database HSN/SAC when frontend did not provide it.
           */
          if (!item.hsnSac) {
            item.hsnSac = dbItem.hsnSac || undefined;
          }

          /*
           * Resolve unit name from Unit table.
           */
          if (!item.unit && dbItem.unitId) {
            const unit = await tx.unit.findUnique({
              where: {
                id: dbItem.unitId,
              },
              select: {
                shortName: true,
              },
            });

            item.unit = unit?.shortName || undefined;
          }
        } else if (inventoryUnitIds.length > 0) {
          throw new AppError(
            `Inventory units require a valid itemId for "${item.itemName}"`,
            400,
          );
        }

        /* ===================================================
           CALCULATE FINANCIAL VALUES
        =================================================== */

        const calc = calculateLineItem({
          quantity: item.quantity,
          rate: item.rate,
          discountPercent: item.discountPercent ?? 0,
          gstRate: item.gstRate ?? 0,
          isInterState,
        });

        lineCalcs.push({
          ...calc,
          itemId: item.itemId || null,
          itemName: item.itemName,
          hsnSac: item.hsnSac,
          unit: item.unit,
          inventoryUnitIds,
        });
      }

      /* =====================================================
         STOCK VALIDATION
      ===================================================== */

      for (const [itemId, requestedQty] of requestedStock) {
        const item = itemMap.get(itemId);

        if (!item) {
          throw new AppError("Item not found", 404);
        }

        if (item.currentStock.lessThan(requestedQty)) {
          throw new AppError(
            `Insufficient stock for "${item.name}". Available: ${item.currentStock}, Requested: ${requestedQty}`,
            400,
          );
        }

        /*
         * For serialized products, quantity must correspond
         * exactly to selected physical units.
         */
        if (item.trackSerial) {
          const selectedUnits = requestedInventoryUnits.get(itemId) || [];

          if (selectedUnits.length !== Number(requestedQty)) {
            throw new AppError(
              `Serialized inventory mismatch for "${item.name}". Required: ${requestedQty}, Selected: ${selectedUnits.length}`,
              400,
            );
          }
        }
      }

      /* =====================================================
         TOTALS
      ===================================================== */

      const totals = calculateInvoiceTotals(lineCalcs);

      const paidAmount = toDecimal(input.paidAmount ?? 0);

      if (paidAmount.lt(0)) {
        throw new AppError("Paid amount cannot be negative", 400);
      }

      if (paidAmount.gt(totals.grandTotal)) {
        throw new AppError("Paid amount cannot exceed invoice total", 400);
      }

      const balanceAmount = roundMoney(totals.grandTotal.minus(paidAmount));

      /* =====================================================
         STATUS
      ===================================================== */

      let status = input.status || "UNPAID";

      if (status !== "DRAFT") {
        if (paidAmount.gte(totals.grandTotal) && totals.grandTotal.gt(0)) {
          status = "PAID";
        } else if (paidAmount.gt(0)) {
          status = "PARTIALLY_PAID";
        } else {
          status = "UNPAID";
        }
      }

      /* =====================================================
         INVOICE NUMBER
      ===================================================== */

      const invoiceNumber = await getNextInvoiceNumber(businessId, tx);

      /* =====================================================
         CREATE SALE
      ===================================================== */

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

      /* =====================================================
         SERIALIZED INVENTORY VALIDATION + UPDATE
      ===================================================== */

      /*
       * DRAFT:
       * ----------------
       * Do NOT reserve, sell, or modify InventoryUnit rows.
       *
       * A draft is only an invoice draft.
       *
       * NON-DRAFT:
       * ----------------
       * Validate exact physical units and atomically mark
       * them SOLD.
       */
      if (status !== "DRAFT") {
        for (const [itemId, inventoryUnitIds] of requestedInventoryUnits) {
          if (inventoryUnitIds.length === 0) {
            continue;
          }

          const inventoryUnits = await tx.inventoryUnit.findMany({
            where: {
              id: {
                in: inventoryUnitIds,
              },
              businessId,
              itemId,
            },
            select: {
              id: true,
              status: true,
              itemId: true,
              businessId: true,
            },
          });

          if (inventoryUnits.length !== inventoryUnitIds.length) {
            throw new AppError(
              `One or more selected IMEI/serial units for item ${itemId} do not belong to this business or item`,
              409,
            );
          }

          const inventoryMap = new Map(
            inventoryUnits.map((unit) => [unit.id, unit]),
          );

          for (const unitId of inventoryUnitIds) {
            const unit = inventoryMap.get(unitId);

            if (!unit) {
              throw new AppError("Selected inventory unit was not found", 409);
            }

            /*
             * AVAILABLE and RETURNED are sellable.
             *
             * RESERVED/SOLD/DAMAGED/LOST are not.
             */
            if (unit.status !== "AVAILABLE" && unit.status !== "RETURNED") {
              throw new AppError(
                `Inventory unit ${unitId} is no longer available`,
                409,
              );
            }
          }

          /*
           * Conditional update:
           *
           * The WHERE clause includes status = AVAILABLE/RETURNED.
           * Therefore two concurrent sales cannot both successfully
           * sell the same physical unit.
           */
          const updated = await tx.inventoryUnit.updateMany({
            where: {
              id: {
                in: inventoryUnitIds,
              },
              businessId,
              itemId,
              status: {
                in: ["AVAILABLE", "RETURNED"],
              },
            },
            data: {
              status: "SOLD",
              saleId: created.id,
              soldAt: new Date(),
            },
          });

          if (updated.count !== inventoryUnitIds.length) {
            throw new AppError(
              "One or more selected IMEI/serial units were sold or changed by another transaction. Please refresh and try again.",
              409,
            );
          }
        }
      }

      /* =====================================================
         ATTACH INVENTORY UNITS TO SALE ITEMS
      ===================================================== */

      if (status !== "DRAFT") {
        for (const line of lineCalcs) {
          if (!line.itemId || line.inventoryUnitIds.length === 0) {
            continue;
          }

          const saleItem = created.items.find(
            (item) =>
              item.itemId === line.itemId && item.itemName === line.itemName,
          );

          if (!saleItem) {
            throw new AppError(
              `Unable to attach inventory units to sale item "${line.itemName}"`,
              500,
            );
          }

          const attached = await tx.inventoryUnit.updateMany({
            where: {
              id: {
                in: line.inventoryUnitIds,
              },
              businessId,
              itemId: line.itemId,
              saleId: created.id,
            },
            data: {
              saleItemId: saleItem.id,
            },
          });

          if (attached.count !== line.inventoryUnitIds.length) {
            throw new AppError(
              `Unable to attach all inventory units to sale item "${line.itemName}"`,
              500,
            );
          }
        }
      }

      /* =====================================================
         STOCK UPDATE
      ===================================================== */

      if (status !== "DRAFT") {
        for (const [itemId, requestedQty] of requestedStock) {
          const shelfAllocation = await tx.shelfStock.aggregate({
            where: {
              businessId,
              itemId,
            },
            _sum: {
              quantity: true,
            },
          });

          const allocatedShelfQty = toDecimal(
            shelfAllocation._sum.quantity ?? 0,
          );

          const selectedShelfQty =
            requestedShelfTotals.get(itemId) ?? toDecimal(0);

          const selectedShelves = requestedShelfStock.get(itemId);

          if (allocatedShelfQty.gt(0) && !selectedShelfQty.eq(requestedQty)) {
            throw new AppError(
              "Select a shelf for every unit being sold from this item.",
              400,
            );
          }

          if (selectedShelves && !allocatedShelfQty.gt(0)) {
            throw new AppError("This item has no allocated shelf stock.", 400);
          }

          if (selectedShelves) {
            for (const [shelfId, shelfQty] of selectedShelves) {
              const shelf = await tx.shelfLocation.findFirst({
                where: {
                  id: shelfId,
                  businessId,
                  isActive: true,
                },
                select: {
                  id: true,
                  name: true,
                },
              });

              if (!shelf) {
                throw new AppError(
                  "Selected shelf was not found or is inactive.",
                  404,
                );
              }

              const shelfUpdated = await tx.shelfStock.updateMany({
                where: {
                  businessId,
                  itemId,
                  shelfId,
                  quantity: {
                    gte: shelfQty,
                  },
                },
                data: {
                  quantity: {
                    decrement: shelfQty,
                  },
                },
              });

              if (shelfUpdated.count !== 1) {
                throw new AppError(
                  `Insufficient stock on shelf ${shelf.name}. Refresh and try again.`,
                  409,
                );
              }

              await tx.shelfMovement.create({
                data: {
                  businessId,
                  itemId,
                  fromShelfId: shelfId,
                  quantity: shelfQty,
                  movementType: "SALE",
                  referenceType: "sale",
                  referenceId: created.id,
                  reason: `Stock sold from shelf ${shelf.name}`,
                  createdById: input.createdById ?? null,
                },
              });
            }
          }
          /*
           * Conditional update protects against overselling
           * when multiple transactions attempt to sell the
           * same stock concurrently.
           */
          const updated = await tx.item.updateMany({
            where: {
              id: itemId,
              businessId,
              deletedAt: null,
              status: "ACTIVE",
              currentStock: {
                gte: requestedQty as any,
              },
            },

            data: {
              currentStock: {
                decrement: requestedQty as any,
              },
            },
          });

          if (updated.count !== 1) {
            throw new AppError(
              "Stock changed while processing this sale. Please retry.",
              409,
            );
          }

          const item = await tx.item.findUnique({
            where: {
              id: itemId,
            },
            select: {
              currentStock: true,
            },
          });

          if (!item) {
            throw new AppError("Item disappeared while processing sale", 409);
          }

          await tx.stockMovement.create({
            data: {
              businessId,

              itemId,

              type: "SALE",

              quantityOut: requestedQty as any,

              balance: item.currentStock as any,

              referenceType: "sale",

              referenceId: created.id,
            },
          });
        }

        /* ===================================================
           CUSTOMER BALANCE
        =================================================== */

        if (input.customerId && balanceAmount.gt(0)) {
          await tx.customer.update({
            where: {
              id: input.customerId,
            },

            data: {
              currentBalance: {
                increment: balanceAmount as any,
              },
            },
          });
        }

        /* ===================================================
           PAYMENT
        =================================================== */

        if (paidAmount.gt(0)) {
          const payment = await tx.paymentIn.create({
            data: {
              businessId,

              customerId: input.customerId || null,

              amount: paidAmount as any,

              date: input.date || new Date(),

              paymentMethod: input.paymentMethod || "cash",

              createdById: input.createdById || null,

              allocations: {
                create: [
                  {
                    saleId: created.id,

                    amount: paidAmount as any,
                  },
                ],
              },
            },
          });

          /* ===============================================
             CASH ACCOUNT
          =============================================== */

          if (input.paymentMethod === "cash" || !input.paymentMethod) {
            const cashAccount = await tx.bankAccount.findFirst({
              where: {
                businessId,
                isCash: true,
                status: "ACTIVE",
              },
            });

            if (cashAccount) {
              const newBalance = toDecimal(cashAccount.currentBalance).plus(
                paidAmount,
              );

              await tx.bankAccount.update({
                where: {
                  id: cashAccount.id,
                },

                data: {
                  currentBalance: newBalance as any,
                },
              });

              await tx.bankTransaction.create({
                data: {
                  businessId,

                  bankAccountId: cashAccount.id,

                  type: "RECEIPT",

                  amount: paidAmount as any,

                  balance: newBalance as any,

                  referenceType: "payment_in",

                  referenceId: payment.id,

                  description: `Payment for ${invoiceNumber}`,
                },
              });
            }
          }
        }
      }

      /* =====================================================
         AUDIT
      ===================================================== */

      await tx.auditLog.create({
        data: {
          businessId,

          userId: input.createdById || null,

          action: "CREATE",

          module: "sales",

          recordId: created.id,

          recordName: invoiceNumber,

          details: JSON.stringify({
            grandTotal: totals.grandTotal.toString(),

            status,

            serializedUnits: Array.from(
              requestedInventoryUnits.values(),
            ).reduce((total, ids) => total + ids.length, 0),
          }),
        },
      });

      /*
       * Return the sale with the exact inventory units attached.
       */
      return tx.sale.findUnique({
        where: {
          id: created.id,
        },
        include: {
          customer: true,

          items: {
            include: {
              item: true,
              inventoryUnits: {
                select: {
                  id: true,
                  imei: true,
                  serialNumber: true,
                  status: true,
                  purchasePrice: true,
                },
              },
            },
          },
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,

      maxWait: 10_000,

      timeout: 20_000,
    },
  );
}

/* =========================================================
   GET SALES
========================================================= */

export async function getSales(
  businessId: string,
  options: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    from?: Date;
    to?: Date;
  },
) {
  const page = Math.max(1, options.page || 1);

  const limit = Math.min(100, Math.max(1, options.limit || 20));

  const skip = (page - 1) * limit;

  const where: Prisma.SaleWhereInput = {
    businessId,
    deletedAt: null,
  };

  if (options.status) {
    where.status = options.status as any;
  }

  if (options.from || options.to) {
    where.date = {};

    if (options.from) {
      where.date.gte = options.from;
    }

    if (options.to) {
      where.date.lte = options.to;
    }
  }

  if (options.search && options.search.trim()) {
    const search = options.search.trim();

    where.OR = [
      {
        invoiceNumber: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        customer: {
          name: {
            contains: search,
            mode: "insensitive",
          },
        },
      },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.sale.findMany({
      where,

      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },

        items: {
          include: {
            inventoryUnits: {
              select: {
                id: true,
                imei: true,
                serialNumber: true,
                status: true,
              },
            },
          },
        },
      },

      orderBy: [
        {
          date: "desc",
        },
        {
          id: "desc",
        },
      ],

      skip,

      take: limit,
    }),

    prisma.sale.count({
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
   GET SALE
========================================================= */

export async function getSaleById(businessId: string, id: string) {
  const sale = await prisma.sale.findFirst({
    where: {
      id,
      businessId,
      deletedAt: null,
    },

    include: {
      customer: true,

      items: {
        include: {
          item: true,

          inventoryUnits: {
            select: {
              id: true,
              imei: true,
              serialNumber: true,
              status: true,
              purchasePrice: true,
            },
          },
        },
      },

      payments: {
        include: {
          paymentIn: true,
        },
      },
    },
  });

  if (!sale) {
    throw new AppError("Sale not found", 404);
  }

  return sale;
}

/* =========================================================
   CANCEL SALE
========================================================= */

export async function cancelSale(
  businessId: string,
  id: string,
  userId?: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const sale = await tx.sale.findFirst({
        where: {
          id,
          businessId,
          deletedAt: null,
        },

        include: {
          items: true,

          inventoryUnits: {
            select: {
              id: true,
              itemId: true,
              saleId: true,
              saleItemId: true,
              status: true,
            },
          },
        },
      });

      if (!sale) {
        throw new AppError("Sale not found", 404);
      }

      if (sale.status === "CANCELLED") {
        throw new AppError("Sale already cancelled", 400);
      }

      /*
       * DRAFT SALES HAVE NEVER CONSUMED STOCK.
       *
       * Therefore:
       * - do not restore Item.currentStock
       * - do not create SALE_RETURN movement
       * - there should normally be no SOLD InventoryUnits
       */
      if (sale.status !== "DRAFT") {
        /* ===============================================
           RESTORE SERIALIZED INVENTORY
        =============================================== */

        const soldUnits = sale.inventoryUnits.filter(
          (unit) => unit.status === "SOLD" && unit.saleId === sale.id,
        );

        if (soldUnits.length > 0) {
          /*
           * RETURNED is used here rather than AVAILABLE
           * because this physical unit has completed a sale
           * lifecycle and is now back in inventory.
           */
          const restored = await tx.inventoryUnit.updateMany({
            where: {
              id: {
                in: soldUnits.map((unit) => unit.id),
              },
              businessId,
              saleId: sale.id,
              status: "SOLD",
            },
            data: {
              status: "RETURNED",
              saleId: null,
              saleItemId: null,
              soldAt: null,
            },
          });

          if (restored.count !== soldUnits.length) {
            throw new AppError(
              "One or more serialized inventory units changed while cancelling the sale. Please retry.",
              409,
            );
          }
        }

        /* ===============================================
           RESTORE SHELF STOCK
        =============================================== */

        const saleShelfMovements =
          await tx.shelfMovement.findMany({
            where: {
              businessId,
              referenceType: 'sale',
              referenceId: sale.id,
              movementType: 'SALE',
            },
          });

        for (const movement of saleShelfMovements) {
          if (!movement.fromShelfId) {
            continue;
          }

          await tx.shelfStock.upsert({
            where: {
              shelfId_itemId: {
                shelfId: movement.fromShelfId,
                itemId: movement.itemId,
              },
            },
            create: {
              businessId,
              shelfId: movement.fromShelfId,
              itemId: movement.itemId,
              quantity: movement.quantity,
            },
            update: {
              quantity: {
                increment: movement.quantity,
              },
            },
          });

          await tx.shelfMovement.create({
            data: {
              businessId,
              itemId: movement.itemId,
              toShelfId: movement.fromShelfId,
              quantity: movement.quantity,
              movementType: 'SALE_CANCEL',
              referenceType: 'sale_cancel',
              referenceId: sale.id,
              reason: 'Shelf stock restored after sale cancellation',
              createdById: userId ?? null,
            },
          });
        }

        /* ===============================================
           RESTORE NORMAL STOCK
        =============================================== */

        for (const saleItem of sale.items) {
          if (!saleItem.itemId) {
            continue;
          }

          const item = await tx.item.update({
            where: {
              id: saleItem.itemId,
            },

            data: {
              currentStock: {
                increment: saleItem.quantity as any,
              },
            },
          });

          await tx.stockMovement.create({
            data: {
              businessId,

              itemId: saleItem.itemId,

              type: "SALE_RETURN",

              quantityIn: saleItem.quantity as any,

              balance: item.currentStock as any,

              referenceType: "sale_cancel",

              referenceId: sale.id,

              notes: "Sale cancelled",
            },
          });
        }

        /* ===============================================
           CUSTOMER BALANCE
        =============================================== */

        if (sale.customerId && toDecimal(sale.balanceAmount).gt(0)) {
          await tx.customer.update({
            where: {
              id: sale.customerId,
            },

            data: {
              currentBalance: {
                decrement: sale.balanceAmount as any,
              },
            },
          });
        }
      }

      /* ===============================================
         CANCEL SALE
      =============================================== */

      await tx.sale.update({
        where: {
          id,
        },

        data: {
          status: "CANCELLED",
        },
      });

      /* ===============================================
         AUDIT
      =============================================== */

      await tx.auditLog.create({
        data: {
          businessId,

          userId: userId || null,

          action: "CANCEL",

          module: "sales",

          recordId: id,

          recordName: sale.invoiceNumber,

          details: JSON.stringify({
            previousStatus: sale.status,

            restoredSerializedUnits: sale.inventoryUnits.filter(
              (unit) => unit.status === "SOLD" && unit.saleId === sale.id,
            ).length,
          }),
        },
      });

      return {
        message: "Sale cancelled successfully",
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,

      maxWait: 10_000,

      timeout: 20_000,
    },
  );
}
