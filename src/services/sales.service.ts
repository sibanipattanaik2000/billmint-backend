import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import {
  calculateLineItem,
  calculateInvoiceTotals,
  toDecimal,
  roundMoney,
} from '../utils/money';
import { Decimal } from '../utils/money';
import { Prisma } from '@prisma/client';

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

/*
 * calculateLineItem() only returns the financial calculation fields.
 * A SaleItem additionally needs the item information that is stored
 * in the SaleItem table.
 */
type CalculatedSaleLine = ReturnType<typeof calculateLineItem> & {
  itemId: string | null;
  itemName: string;
  hsnSac?: string;
  unit?: string;
};

type TransactionClient = Prisma.TransactionClient;

/* =========================================================
   INVOICE NUMBER
========================================================= */

async function getNextInvoiceNumber(
  businessId: string,
  tx: TransactionClient
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
    throw new AppError(
      'Invoice sequence not configured',
      500
    );
  }

  const invoiceNumber =
    `${seq.prefix}-${String(seq.nextNumber).padStart(6, '0')}`;

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
   CREATE SALE
========================================================= */

export async function createSale(
  businessId: string,
  input: CreateSaleInput
) {
  if (!input.items || input.items.length === 0) {
    throw new AppError(
      'At least one item is required',
      400
    );
  }

  if (input.items.length > 100) {
    throw new AppError(
      'A sale cannot contain more than 100 line items',
      400
    );
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
    throw new AppError(
      'Business not found',
      404
    );
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
            status: 'ACTIVE',
          },
          select: {
            id: true,
            state: true,
          },
        });

        if (!customer) {
          throw new AppError(
            'Customer not found',
            404
          );
        }

        customerState = customer.state;
      }

      const isInterState = Boolean(
        business.state &&
        customerState &&
        business.state.toLowerCase() !==
          customerState.toLowerCase()
      );

      /* =====================================================
         LOAD ITEMS
      ===================================================== */

      const itemIds = Array.from(
        new Set(
          input.items
            .map((item) => item.itemId)
            .filter(
              (id): id is string =>
                Boolean(id)
            )
        )
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
                status: 'ACTIVE',
              },
              select: {
                id: true,
                name: true,
                currentStock: true,
                gstRate: true,
                hsnSac: true,
                unitId: true,
              },
            })
          : [];

      const itemMap = new Map(
        dbItems.map((item) => [
          item.id,
          item,
        ])
      );

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
      const requestedStock = new Map<
        string,
        Decimal
      >();

      for (const item of input.items) {
        /* -------------------------------
           QUANTITY
        -------------------------------- */

        if (!Number.isFinite(item.quantity)) {
          throw new AppError(
            `Invalid quantity for "${item.itemName}"`,
            400
          );
        }

        if (item.quantity <= 0) {
          throw new AppError(
            `Quantity must be greater than zero for "${item.itemName}"`,
            400
          );
        }

        /* -------------------------------
           RATE
        -------------------------------- */

        if (
          !Number.isFinite(item.rate) ||
          item.rate < 0
        ) {
          throw new AppError(
            `Invalid rate for "${item.itemName}"`,
            400
          );
        }

        /* -------------------------------
           DISCOUNT
        -------------------------------- */

        if (
          item.discountPercent !== undefined
        ) {
          if (
            !Number.isFinite(
              item.discountPercent
            ) ||
            item.discountPercent < 0 ||
            item.discountPercent > 100
          ) {
            throw new AppError(
              `Invalid discount for "${item.itemName}"`,
              400
            );
          }
        }

        /* -------------------------------
           GST
        -------------------------------- */

        if (
          item.gstRate !== undefined
        ) {
          if (
            !Number.isFinite(
              item.gstRate
            ) ||
            item.gstRate < 0 ||
            item.gstRate > 100
          ) {
            throw new AppError(
              `Invalid GST rate for "${item.itemName}"`,
              400
            );
          }
        }

        /* ===================================================
           DATABASE ITEM
        =================================================== */

        if (item.itemId) {
          const dbItem =
            itemMap.get(item.itemId);

          if (!dbItem) {
            throw new AppError(
              `Item not found: ${item.itemName}`,
              404
            );
          }

          const qty =
            toDecimal(item.quantity);

          const existing =
            requestedStock.get(
              dbItem.id
            ) || toDecimal(0);

          requestedStock.set(
            dbItem.id,
            existing.plus(qty)
          );

          /*
           * Use database GST when frontend did not provide it.
           */
          if (
            item.gstRate === undefined
          ) {
            item.gstRate =
              Number(dbItem.gstRate);
          }

          /*
           * Use database HSN/SAC when frontend did not provide it.
           */
          if (!item.hsnSac) {
            item.hsnSac =
              dbItem.hsnSac ||
              undefined;
          }

          /*
           * Resolve unit name from Unit table.
           */
          if (
            !item.unit &&
            dbItem.unitId
          ) {
            const unit =
              await tx.unit.findUnique({
                where: {
                  id: dbItem.unitId,
                },
                select: {
                  shortName: true,
                },
              });

            item.unit =
              unit?.shortName ||
              undefined;
          }
        }

        /* ===================================================
           CALCULATE FINANCIAL VALUES
        =================================================== */

        const calc =
          calculateLineItem({
            quantity: item.quantity,
            rate: item.rate,
            discountPercent:
              item.discountPercent ?? 0,
            gstRate:
              item.gstRate ?? 0,
            isInterState,
          });

        /*
         * IMPORTANT:
         * CalculatedSaleLine contains both the financial
         * calculation fields AND SaleItem metadata.
         */
        lineCalcs.push({
          ...calc,
          itemId:
            item.itemId || null,
          itemName:
            item.itemName,
          hsnSac:
            item.hsnSac,
          unit:
            item.unit,
        });
      }

      /* =====================================================
         STOCK VALIDATION
      ===================================================== */

      for (const [
        itemId,
        requestedQty,
      ] of requestedStock) {
        const item =
          itemMap.get(itemId);

        if (!item) {
          throw new AppError(
            'Item not found',
            404
          );
        }

        if (
          item.currentStock.lessThan(
            requestedQty
          )
        ) {
          throw new AppError(
            `Insufficient stock for "${item.name}". Available: ${item.currentStock}, Requested: ${requestedQty}`,
            400
          );
        }
      }

      /* =====================================================
         TOTALS
      ===================================================== */

      const totals =
        calculateInvoiceTotals(
          lineCalcs
        );

      const paidAmount =
        toDecimal(
          input.paidAmount ?? 0
        );

      if (paidAmount.lt(0)) {
        throw new AppError(
          'Paid amount cannot be negative',
          400
        );
      }

      if (
        paidAmount.gt(
          totals.grandTotal
        )
      ) {
        throw new AppError(
          'Paid amount cannot exceed invoice total',
          400
        );
      }

      const balanceAmount =
        roundMoney(
          totals.grandTotal.minus(
            paidAmount
          )
        );

      /* =====================================================
         STATUS
      ===================================================== */

      let status =
        input.status || 'UNPAID';

      if (status !== 'DRAFT') {
        if (
          paidAmount.gte(
            totals.grandTotal
          ) &&
          totals.grandTotal.gt(0)
        ) {
          status = 'PAID';
        } else if (
          paidAmount.gt(0)
        ) {
          status =
            'PARTIALLY_PAID';
        } else {
          status = 'UNPAID';
        }
      }

      /* =====================================================
         INVOICE NUMBER
      ===================================================== */

      const invoiceNumber =
        await getNextInvoiceNumber(
          businessId,
          tx
        );

      /* =====================================================
         CREATE SALE
      ===================================================== */

      const created =
        await tx.sale.create({
          data: {
            businessId,

            invoiceNumber,

            customerId:
              input.customerId ||
              null,

            date:
              input.date ||
              new Date(),

            dueDate:
              input.dueDate ||
              null,

            status:
              status as any,

            placeOfSupply:
              input.placeOfSupply ||
              customerState ||
              business.state,

            isInterState,

            subtotal:
              totals.subtotal as any,

            discountAmount:
              totals.discountAmount as any,

            taxableAmount:
              totals.taxableAmount as any,

            cgstAmount:
              totals.cgstAmount as any,

            sgstAmount:
              totals.sgstAmount as any,

            igstAmount:
              totals.igstAmount as any,

            cessAmount:
              totals.cessAmount as any,

            roundOff:
              totals.roundOff as any,

            grandTotal:
              totals.grandTotal as any,

            paidAmount:
              paidAmount as any,

            balanceAmount:
              balanceAmount as any,

            paymentMethod:
              input.paymentMethod ||
              null,

            notes:
              input.notes ||
              null,

            terms:
              input.terms ||
              null,

            createdById:
              input.createdById ||
              null,

            items: {
              create:
                lineCalcs.map(
                  (lc) => ({
                    itemId:
                      lc.itemId ||
                      null,

                    itemName:
                      lc.itemName,

                    hsnSac:
                      lc.hsnSac ||
                      null,

                    quantity:
                      lc.quantity as any,

                    unit:
                      lc.unit ||
                      null,

                    rate:
                      lc.rate as any,

                    discountPercent:
                      lc.discountPercent as any,

                    discountAmount:
                      lc.discountAmount as any,

                    taxableAmount:
                      lc.taxableAmount as any,

                    gstRate:
                      lc.gstRate as any,

                    cgstAmount:
                      lc.cgstAmount as any,

                    sgstAmount:
                      lc.sgstAmount as any,

                    igstAmount:
                      lc.igstAmount as any,

                    amount:
                      lc.amount as any,
                  })
                ),
            },
          },

          include: {
            items: true,
            customer: true,
          },
        });

      /* =====================================================
         STOCK UPDATE
      ===================================================== */

      if (status !== 'DRAFT') {
        for (const [
          itemId,
          requestedQty,
        ] of requestedStock) {
          /*
           * Conditional update protects against overselling
           * when multiple transactions attempt to sell the
           * same stock concurrently.
           */
          const updated =
            await tx.item.updateMany({
              where: {
                id: itemId,
                businessId,
                deletedAt: null,
                status: 'ACTIVE',
                currentStock: {
                  gte:
                    requestedQty as any,
                },
              },

              data: {
                currentStock: {
                  decrement:
                    requestedQty as any,
                },
              },
            });

          if (updated.count !== 1) {
            throw new AppError(
              'Stock changed while processing this sale. Please retry.',
              409
            );
          }

          const item =
            await tx.item.findUnique({
              where: {
                id: itemId,
              },
              select: {
                currentStock: true,
              },
            });

          if (!item) {
            throw new AppError(
              'Item disappeared while processing sale',
              409
            );
          }

          await tx.stockMovement.create({
            data: {
              businessId,

              itemId,

              type: 'SALE',

              quantityOut:
                requestedQty as any,

              balance:
                item.currentStock as any,

              referenceType:
                'sale',

              referenceId:
                created.id,
            },
          });
        }

        /* ===================================================
           CUSTOMER BALANCE
        =================================================== */

        if (
          input.customerId &&
          balanceAmount.gt(0)
        ) {
          await tx.customer.update({
            where: {
              id:
                input.customerId,
            },

            data: {
              currentBalance: {
                increment:
                  balanceAmount as any,
              },
            },
          });
        }

        /* ===================================================
           PAYMENT
        =================================================== */

        if (paidAmount.gt(0)) {
          const payment =
            await tx.paymentIn.create({
              data: {
                businessId,

                customerId:
                  input.customerId ||
                  null,

                amount:
                  paidAmount as any,

                date:
                  input.date ||
                  new Date(),

                paymentMethod:
                  input.paymentMethod ||
                  'cash',

                createdById:
                  input.createdById ||
                  null,

                allocations: {
                  create: [
                    {
                      saleId:
                        created.id,

                      amount:
                        paidAmount as any,
                    },
                  ],
                },
              },
            });

          /* ===============================================
             CASH ACCOUNT
          =============================================== */

          if (
            input.paymentMethod ===
              'cash' ||
            !input.paymentMethod
          ) {
            const cashAccount =
              await tx.bankAccount.findFirst({
                where: {
                  businessId,
                  isCash: true,
                  status: 'ACTIVE',
                },
              });

            if (cashAccount) {
              const newBalance =
                toDecimal(
                  cashAccount.currentBalance
                ).plus(
                  paidAmount
                );

              await tx.bankAccount.update({
                where: {
                  id:
                    cashAccount.id,
                },

                data: {
                  currentBalance:
                    newBalance as any,
                },
              });

              await tx.bankTransaction.create({
                data: {
                  businessId,

                  bankAccountId:
                    cashAccount.id,

                  type: 'RECEIPT',

                  amount:
                    paidAmount as any,

                  balance:
                    newBalance as any,

                  referenceType:
                    'payment_in',

                  referenceId:
                    payment.id,

                  description:
                    `Payment for ${invoiceNumber}`,
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

          userId:
            input.createdById ||
            null,

          action:
            'CREATE',

          module:
            'sales',

          recordId:
            created.id,

          recordName:
            invoiceNumber,

          details:
            JSON.stringify({
              grandTotal:
                totals.grandTotal.toString(),

              status,
            }),
        },
      });

      return created;
    },
    {
      isolationLevel:
        Prisma.TransactionIsolationLevel.Serializable,

      maxWait: 10_000,

      timeout: 20_000,
    }
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
  }
) {
  const page =
    Math.max(
      1,
      options.page || 1
    );

  const limit =
    Math.min(
      100,
      Math.max(
        1,
        options.limit || 20
      )
    );

  const skip =
    (page - 1) * limit;

  const where: Prisma.SaleWhereInput = {
    businessId,
    deletedAt: null,
  };

  if (options.status) {
    where.status =
      options.status as any;
  }

  if (
    options.from ||
    options.to
  ) {
    where.date = {};

    if (options.from) {
      where.date.gte =
        options.from;
    }

    if (options.to) {
      where.date.lte =
        options.to;
    }
  }

  if (
    options.search &&
    options.search.trim()
  ) {
    const search =
      options.search.trim();

    where.OR = [
      {
        invoiceNumber: {
          contains: search,
          mode: 'insensitive',
        },
      },
      {
        customer: {
          name: {
            contains: search,
            mode: 'insensitive',
          },
        },
      },
    ];
  }

  const [data, total] =
    await Promise.all([
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

          items: true,
        },

        orderBy: [
          {
            date: 'desc',
          },
          {
            id: 'desc',
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
      totalPages:
        Math.ceil(
          total / limit
        ),
    },
  };
}

/* =========================================================
   GET SALE
========================================================= */

export async function getSaleById(
  businessId: string,
  id: string
) {
  const sale =
    await prisma.sale.findFirst({
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
    throw new AppError(
      'Sale not found',
      404
    );
  }

  return sale;
}

/* =========================================================
   CANCEL SALE
========================================================= */

export async function cancelSale(
  businessId: string,
  id: string,
  userId?: string
) {
  return prisma.$transaction(
    async (tx) => {
      const sale =
        await tx.sale.findFirst({
          where: {
            id,
            businessId,
            deletedAt: null,
          },

          include: {
            items: true,
          },
        });

      if (!sale) {
        throw new AppError(
          'Sale not found',
          404
        );
      }

      if (
        sale.status ===
        'CANCELLED'
      ) {
        throw new AppError(
          'Sale already cancelled',
          400
        );
      }

      /* ===============================================
         RESTORE STOCK
      =============================================== */

      for (const saleItem of sale.items) {
        if (!saleItem.itemId) {
          continue;
        }

        const item =
          await tx.item.update({
            where: {
              id:
                saleItem.itemId,
            },

            data: {
              currentStock: {
                increment:
                  saleItem.quantity as any,
              },
            },
          });

        await tx.stockMovement.create({
          data: {
            businessId,

            itemId:
              saleItem.itemId,

            type:
              'SALE_RETURN',

            quantityIn:
              saleItem.quantity as any,

            balance:
              item.currentStock as any,

            referenceType:
              'sale_cancel',

            referenceId:
              sale.id,

            notes:
              'Sale cancelled',
          },
        });
      }

      /* ===============================================
         CUSTOMER BALANCE
      =============================================== */

      if (
        sale.customerId &&
        toDecimal(
          sale.balanceAmount
        ).gt(0)
      ) {
        await tx.customer.update({
          where: {
            id:
              sale.customerId,
          },

          data: {
            currentBalance: {
              decrement:
                sale.balanceAmount as any,
            },
          },
        });
      }

      /* ===============================================
         CANCEL SALE
      =============================================== */

      await tx.sale.update({
        where: {
          id,
        },

        data: {
          status:
            'CANCELLED',
        },
      });

      /* ===============================================
         AUDIT
      =============================================== */

      await tx.auditLog.create({
        data: {
          businessId,

          userId:
            userId || null,

          action:
            'CANCEL',

          module:
            'sales',

          recordId:
            id,

          recordName:
            sale.invoiceNumber,
        },
      });

      return {
        message:
          'Sale cancelled successfully',
      };
    },
    {
      isolationLevel:
        Prisma.TransactionIsolationLevel.Serializable,

      maxWait: 10_000,

      timeout: 20_000,
    }
  );
}