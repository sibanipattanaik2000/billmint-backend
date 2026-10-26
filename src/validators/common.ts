import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const idParamSchema = z.object({
  id: z.string().uuid("Invalid ID"),
});

export const gstinSchema = z
  .string()
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    "Invalid GSTIN",
  )
  .optional()
  .or(z.literal(""));

export const panSchema = z
  .string()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN")
  .optional()
  .or(z.literal(""));

export const phoneSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, "Invalid Indian mobile number")
  .optional()
  .or(z.literal(""));

export const pinSchema = z
  .string()
  .regex(/^\d{6}$/, "PIN must be 6 digits")
  .optional()
  .or(z.literal(""));

export const customerSchema = z.object({
  name: z.string().min(1, "Customer name is required").max(200),
  businessName: z.string().max(200).optional().or(z.literal("")),
  phone: phoneSchema,
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(500).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(100).optional().or(z.literal("")),
  pinCode: pinSchema,
  gstin: gstinSchema,
  pan: panSchema,
  openingBalance: z.coerce.number().default(0),
  creditLimit: z.coerce.number().optional().nullable(),
  paymentTerms: z.coerce.number().int().optional().nullable(),
  notes: z.string().max(1000).optional().or(z.literal("")),
});

export const supplierSchema = z.object({
  name: z.string().min(1, "Supplier name is required").max(200),
  businessName: z.string().max(200).optional().or(z.literal("")),
  phone: phoneSchema,
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(500).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(100).optional().or(z.literal("")),
  pinCode: pinSchema,
  gstin: gstinSchema,
  pan: panSchema,
  openingBalance: z.coerce.number().default(0),
  paymentTerms: z.coerce.number().int().optional().nullable(),
  notes: z.string().max(1000).optional().or(z.literal("")),
});

export const itemSchema = z.object({
  name: z.string().trim().min(1, "Item name is required").max(200),

  // Internal Item Code used for Sales lookup.
  sku: z.string().trim().max(50).optional().or(z.literal("")),

  // Physical barcode.
  barcode: z.string().trim().max(100).optional().or(z.literal("")),

  // Canonical model group, e.g. iPhone 17 Pro Max 512GB.
  modelName: z.string().trim().max(200).optional().or(z.literal("")),

  // Optional code assigned to an individual physical device.
  deviceCode: z.string().trim().max(100).optional().or(z.literal("")),

  // IMEI is optional at the generic schema level because
  // services can also be non-serialized products/services.
  // createItem() will enforce it when trackSerial=true.
  imei: z
    .string()
    .trim()
    .regex(/^\d{15}$/, "IMEI must contain exactly 15 digits")
    .optional()
    .or(z.literal("")),

  categoryId: z.string().uuid().optional().nullable(),

  brandId: z.string().uuid().optional().nullable(),

  unitId: z.string().uuid().optional().nullable(),

  description: z.string().trim().max(1000).optional().or(z.literal("")),

  purchasePrice: z.coerce.number().finite().min(0).default(0),

  salePrice: z.coerce.number().finite().min(0).default(0),

  mrp: z.coerce.number().finite().min(0).optional().nullable(),

  openingStock: z.coerce.number().finite().min(0).default(0),

  minimumStock: z.coerce.number().finite().min(0).default(0),

  gstRate: z.coerce.number().finite().min(0).max(100).default(18),

  hsnSac: z.string().trim().max(20).optional().or(z.literal("")),

  discountPercent: z.coerce.number().finite().min(0).max(100).default(0),

  supplierId: z.string().uuid().optional().nullable(),

  trackBatch: z.boolean().default(false),

  trackSerial: z.boolean().default(false),

  trackExpiry: z.boolean().default(false),
  sourceStoreCode: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9_-]*$/, "Invalid Source Store Code")
    .transform((value) => value.toUpperCase())
    .optional()
    .or(z.literal("")),
});

export const saleItemSchema = z.object({
  itemId: z.string().uuid().optional().nullable(),

  itemName: z.string().trim().min(1).max(200),
  // Exact physical units selected for a serialized sale.
  inventoryUnitIds: z.array(z.string().trim().min(1).max(100)).optional(),

  hsnSac: z.string().trim().max(20).optional().or(z.literal("")),

  quantity: z.coerce.number().finite().positive("Quantity must be positive"),

  unit: z.string().trim().max(50).optional().or(z.literal("")),

  rate: z.coerce.number().finite().min(0),

  discountPercent: z.coerce.number().finite().min(0).max(100).default(0),

  gstRate: z.coerce.number().finite().min(0).max(100).default(0),
  shelfId: z.string().uuid().optional().nullable(),
});

export const saleSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),

  date: z.coerce.date().optional(),

  dueDate: z.coerce.date().optional().nullable(),

  placeOfSupply: z.string().trim().max(100).optional().or(z.literal("")),

  items: z
    .array(
      saleItemSchema.extend({
        // One identifier per physical device, when serial tracking is enabled.
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
        imeis: z
          .array(
            z
              .string()
              .trim()
              .regex(/^\d{15}$/, "Each IMEI must contain exactly 15 digits"),
          )
          .optional(),
      }),
    )
    .min(1, "At least one item is required")
    .max(100, "A purchase cannot contain more than 100 items"),

  paymentMethod: z.string().trim().max(50).optional().or(z.literal("")),

  paidAmount: z.coerce.number().finite().min(0).default(0),

  notes: z.string().max(5000).optional().or(z.literal("")),

  terms: z.string().max(5000).optional().or(z.literal("")),

  status: z.enum(["DRAFT", "UNPAID", "PARTIALLY_PAID", "PAID"]).optional(),
});

export const purchaseSchema = z.object({
  supplierId: z.string().uuid().optional().nullable(),

  date: z.coerce.date().optional(),

  dueDate: z.coerce.date().optional().nullable(),

  placeOfSupply: z.string().optional().or(z.literal("")),

  items: z
    .array(
      saleItemSchema.extend({
        serialNumbers: z
          .array(z.string().trim().min(1, "Serial number cannot be empty"))
          .optional(),

        imeis: z
          .array(
            z
              .string()
              .trim()
              .regex(/^\d{15}$/, "IMEI must contain exactly 15 digits"),
          )
          .optional(),
      }),
    )
    .min(1, "At least one item is required")
    .max(100, "A purchase cannot contain more than 100 items"),

  paymentMethod: z.string().optional().or(z.literal("")),

  paidAmount: z.coerce.number().finite().min(0).default(0),

  notes: z.string().optional().or(z.literal("")),

  status: z.enum(["DRAFT", "UNPAID", "PARTIALLY_PAID", "PAID"]).optional(),
});

export const paymentInSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  amount: z.coerce.number().positive("Amount must be positive"),
  date: z.coerce.date().optional(),
  paymentMethod: z.enum(["cash", "upi", "card", "bank", "other"]),
  reference: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  bankAccountId: z.string().uuid().optional().nullable(),
  allocations: z
    .array(
      z.object({
        saleId: z.string().uuid(),
        amount: z.coerce.number().positive(),
      }),
    )
    .optional(),
});

export const paymentOutSchema = z.object({
  supplierId: z.string().uuid().optional().nullable(),
  amount: z.coerce.number().positive("Amount must be positive"),
  date: z.coerce.date().optional(),
  paymentMethod: z.enum(["cash", "upi", "card", "bank", "other"]),
  reference: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  bankAccountId: z.string().uuid().optional().nullable(),
  allocations: z
    .array(
      z.object({
        purchaseId: z.string().uuid(),
        amount: z.coerce.number().positive(),
      }),
    )
    .optional(),
});

export const expenseSchema = z.object({
  categoryId: z.string().uuid().optional().nullable(),
  amount: z.coerce.number().positive("Amount must be positive"),
  date: z.coerce.date().optional(),
  paymentMethod: z.string().optional().or(z.literal("")),
  description: z.string().max(500).optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  bankAccountId: z.string().uuid().optional().nullable(),
});
