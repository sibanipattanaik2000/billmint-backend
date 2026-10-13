import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { AppError, asyncHandler } from "../middleware/errorHandler";
import * as purchaseReturnsService from "../services/purchase-returns.service";
import { paginationSchema } from "../validators/common";

const router = Router();

const purchaseReturnItemSchema = z.object({
  itemId: z.string().trim().min(1).optional().nullable(),
  itemName: z.string().trim().min(1).max(255),
  quantity: z.coerce.number().finite().positive(),
  rate: z.coerce.number().finite().min(0),
  taxAmount: z.coerce.number().finite().min(0).default(0),
});

const createPurchaseReturnSchema = z.object({
  purchaseId: z.string().trim().min(1).optional().nullable(),
  supplierId: z.string().trim().min(1).optional().nullable(),
  date: z.coerce.date().optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
  items: z.array(purchaseReturnItemSchema).min(1).max(500),
});

router.use(authenticate);

router.get(
  "/",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const parsed = paginationSchema.safeParse(req.query);

    if (!parsed.success) {
      throw new AppError("Invalid pagination parameters", 400);
    }

    const result = await purchaseReturnsService.listPurchaseReturns(
      req.user!.businessId,
      parsed.data.page,
      parsed.data.limit,
    );

    res.json({ success: true, ...result });
  }),
);

router.post(
  "/",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const parsed = createPurchaseReturnSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }

    const result = await purchaseReturnsService.createPurchaseReturn(
      req.user!.businessId,
      parsed.data,
    );

    res.status(201).json({ success: true, data: result });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await purchaseReturnsService.getPurchaseReturnById(
      req.user!.businessId,
      String(req.params.id),
    );

    res.json({ success: true, data: result });
  }),
);

export default router;
