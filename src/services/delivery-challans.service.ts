import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

type TransactionClient = Prisma.TransactionClient;

export interface DeliveryChallanItemInput {
  itemId?: string | null;
  itemName?: string;
  quantity: number;
  unit?: string | null;
  notes?: string | null;
}

export interface CreateDeliveryChallanInput {
  customerId?: string | null;
  date?: Date;
  reason?: string | null;
  transportInfo?: string | null;
  notes?: string | null;
  items: DeliveryChallanItemInput[];
}

export interface ListDeliveryChallanOptions {
  page?: number;
  limit?: number;
  search?: string;
  from?: Date;
  to?: Date;
}

const MAX_ITEMS = 100;

function cleanString(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }

  const result = value.trim();
  return result.length > 0 ? result : null;
}

function validateDate(
  value: Date | undefined,
  field: string,
): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return value;
}

function positiveQuantity(
  value: unknown,
  field: string,
): number {
  const quantity = Number(value);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 999999999999999
  ) {
    throw new AppError(
      `${field} must be a valid quantity greater than zero`,
      400,
    );
  }

  return quantity;
}

async function getNextChallanNumber(
  businessId: string,
  tx: TransactionClient,
): Promise<string> {
  // Ensure settings exist for businesses that have not created
  // their settings record yet.
  await tx.businessSettings.upsert({
    where: { businessId },
    create: { businessId },
    update: {},
  });

  // Lock the settings row to prevent concurrent requests from
  // generating the same challan number.
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      challanPrefix: string;
      challanNextNumber: number;
    }>
  >`
    SELECT
      "id",
      "challanPrefix",
      "challanNextNumber"
    FROM "business_settings"
    WHERE "businessId" = ${businessId}
    FOR UPDATE
  `;

  const settings = rows[0];

  if (!settings) {
    throw new AppError(
      "Unable to initialize delivery challan numbering",
      500,
    );
  }

  const prefix = settings.challanPrefix.trim();
  const nextNumber = Number(settings.challanNextNumber);

  if (
    !prefix ||
    !Number.isSafeInteger(nextNumber) ||
    nextNumber < 1
  ) {
    throw new AppError(
      "Invalid delivery challan numbering configuration",
      500,
    );
  }

  await tx.businessSettings.update({
    where: { businessId },
    data: {
      challanNextNumber: { increment: 1 },
    },
  });

  return `${prefix}-${String(nextNumber).padStart(6, "0")}`;
}

/**
 * Create a delivery challan.
 *
 * Creating a challan records goods being dispatched or delivered.
 * It does not change inventory or create a sale.
 */
export async function createDeliveryChallan(
  businessId: string,
  input: CreateDeliveryChallanInput,
) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new AppError(
      "At least one delivery challan item is required",
      400,
    );
  }

  if (input.items.length > MAX_ITEMS) {
    throw new AppError(
      `A delivery challan cannot contain more than ${MAX_ITEMS} items`,
      400,
    );
  }

  const date = validateDate(input.date, "challan date") ?? new Date();
  const customerId = cleanString(input.customerId, "customer ID");
  const reason = cleanString(input.reason, "reason");
  const transportInfo = cleanString(
    input.transportInfo,
    "transport information",
  );
  const notes = cleanString(input.notes, "notes");

  return prisma.$transaction(
    async (tx) => {
      const business = await tx.business.findFirst({
        where: {
          id: businessId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!business) {
        throw new AppError("Business not found", 404);
      }

      if (customerId) {
        const customer = await tx.customer.findFirst({
          where: {
            id: customerId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: { id: true },
        });

        if (!customer) {
          throw new AppError(
            "Customer not found or inactive",
            404,
          );
        }
      }

      const normalizedItems = input.items.map((item, index) => ({
        item,
        index,
        itemId: cleanString(item.itemId, "item ID"),
      }));

      const itemIds = [
        ...new Set(
          normalizedItems
            .map(({ itemId }) => itemId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      const databaseItems = itemIds.length
        ? await tx.item.findMany({
            where: {
              id: { in: itemIds },
              businessId,
              deletedAt: null,
              status: "ACTIVE",
            },
            select: {
              id: true,
              name: true,
              unit: {
                select: { shortName: true },
              },
            },
          })
        : [];

      const itemMap = new Map(
        databaseItems.map((item) => [item.id, item]),
      );

      const items = normalizedItems.map(
        ({ item, index, itemId }) => {
          const databaseItem = itemId
            ? itemMap.get(itemId)
            : undefined;

          if (itemId && !databaseItem) {
            throw new AppError(
              `Item at position ${index + 1} was not found or is inactive`,
              404,
            );
          }

          const itemName =
            cleanString(item.itemName, "item name") ??
            databaseItem?.name ??
            null;

          if (!itemName) {
            throw new AppError(
              `Item name is required at position ${index + 1}`,
              400,
            );
          }

          const quantity = positiveQuantity(
            item.quantity,
            `Quantity for ${itemName}`,
          );

          // The database stores quantities with three decimal places.
          if (
            Math.abs(quantity * 1000 - Math.round(quantity * 1000)) >
            0.000001
          ) {
            throw new AppError(
              `Quantity for ${itemName} cannot have more than three decimal places`,
              400,
            );
          }

          return {
            itemId,
            itemName,
            quantity: quantity.toFixed(3),
            unit:
              cleanString(item.unit, "unit") ??
              databaseItem?.unit?.shortName ??
              null,
            notes: cleanString(item.notes, "item notes"),
          };
        },
      );

      const challanNumber = await getNextChallanNumber(
        businessId,
        tx,
      );

      return tx.deliveryChallan.create({
        data: {
          businessId,
          challanNumber,
          customerId,
          date,
          reason,
          transportInfo,
          notes,
          items: {
            create: items,
          },
        },
        include: {
          customer: true,
          items: true,
        },
      });
    },
    {
      maxWait: 10000,
      timeout: 20000,
    },
  );
}

/**
 * List delivery challans belonging to one business.
 */
export async function listDeliveryChallans(
  businessId: string,
  options: ListDeliveryChallanOptions = {},
) {
  const page = Math.max(
    1,
    Math.floor(options.page ?? 1),
  );

  const limit = Math.min(
    100,
    Math.max(1, Math.floor(options.limit ?? 20)),
  );

  const search = options.search?.trim();
  const from = validateDate(options.from, "from date");
  const to = validateDate(options.to, "to date");

  if (from && to && from > to) {
    throw new AppError(
      "'from' date cannot be after 'to' date",
      400,
    );
  }

  const where: Prisma.DeliveryChallanWhereInput = {
    businessId,
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            {
              challanNumber: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              reason: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              customer: {
                is: {
                  name: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
              },
            },
          ],
        }
      : {}),
  };

  const [data, total] = await Promise.all([
    prisma.deliveryChallan.findMany({
      where,
      include: {
        customer: true,
        items: true,
      },
      orderBy: [
        { date: "desc" },
        { createdAt: "desc" },
      ],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.deliveryChallan.count({ where }),
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

/**
 * Retrieve one delivery challan belonging to the business.
 */
export async function getDeliveryChallanById(
  businessId: string,
  challanId: string,
) {
  const challan = await prisma.deliveryChallan.findFirst({
    where: {
      id: challanId,
      businessId,
    },
    include: {
      customer: true,
      items: true,
    },
  });

  if (!challan) {
    throw new AppError("Delivery challan not found", 404);
  }

  return challan;
}