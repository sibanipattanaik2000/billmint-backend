import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import * as shelvesService from "../services/shelves.service";

const router = Router();

/**
 * GET /shelves
 * List the business's nine default shelves.
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await shelvesService.listShelves(req.businessId!);

    res.json({
      success: true,
      data,
    });
  }),
);

/**
 * GET /shelves/:shelfId/stock
 * View items allocated to a shelf.
 */
router.get(
  "/:shelfId/stock",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const shelfId = String(req.params.shelfId);

    const data = await shelvesService.getShelfStock(
      req.businessId!,
      shelfId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

/**
 * POST /shelves/:shelfId/stock
 * Allocate existing item stock to a shelf.
 */
router.post(
  "/:shelfId/stock",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const bodySchema = z.object({
      itemId: z.string().trim().min(1),
      quantity: z.coerce.number().finite().positive(),
    });

    const parsed = bodySchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }

    const data = await shelvesService.placeStockOnShelf(
      req.businessId!,
      String(req.params.shelfId),
      parsed.data.itemId,
      parsed.data.quantity,
      req.user?.userId,
    );

    res.status(201).json({
      success: true,
      data,
    });
  }),
);

/**
 * POST /shelves/transfer
 * Transfer allocated stock between shelves.
 */
router.post(
  "/transfer",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const bodySchema = z.object({
      itemId: z.string().trim().min(1),
      fromShelfId: z.string().trim().min(1),
      toShelfId: z.string().trim().min(1),
      quantity: z.coerce.number().finite().positive(),
      reason: z.string().trim().max(255).optional(),
    });

    const parsed = bodySchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }

    const data = await shelvesService.transferShelfStock(
      req.businessId!,
      parsed.data.itemId,
      parsed.data.fromShelfId,
      parsed.data.toShelfId,
      parsed.data.quantity,
      parsed.data.reason,
      req.user?.userId,
    );

    res.json({
      success: true,
      data,
    });
  }),
);

export default router;
