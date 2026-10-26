
import { Router } from "express";
import prisma from "../utils/prisma";
import { asyncHandler, AppError } from "../middleware/errorHandler";

const router = Router();

/**
 * Public store profile only.
 * Never return customers, invoices, inventory, payments,
 * financial reports, memberships, or internal business IDs.
 */
const publicStoreSelect = {
  storeCode: true,
  name: true,
  address: true,
  city: true,
  state: true,
  pinCode: true,
  phone: true,
  email: true,
  gstin: true,
} as const;

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const stores = await prisma.business.findMany({
      where: {
        deletedAt: null,
      },
      select: publicStoreSelect,
      orderBy: [
        { city: "asc" },
        { name: "asc" },
      ],
    });

    res.json({
      success: true,
      data: stores,
    });
  }),
);

router.get(
  "/:storeCode",
  asyncHandler(async (req, res) => {
    const storeCode = String(req.params.storeCode ?? "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9_-]{3,20}$/.test(storeCode)) {
      throw new AppError("Invalid Store Code", 400);
    }

    const store = await prisma.business.findFirst({
      where: {
        storeCode,
        deletedAt: null,
      },
      select: publicStoreSelect,
    });

    if (!store) {
      throw new AppError("Store not found", 404);
    }

    res.json({
      success: true,
      data: store,
    });
  }),
);

export default router;
