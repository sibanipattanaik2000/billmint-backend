import { Router, Response } from "express";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { asyncHandler, AppError } from "../middleware/errorHandler";
import * as saleReturnsService from "../services/sale-returns.service";
import { paginationSchema } from "../validators/common";

const router = Router();

const createSaleReturnSchema = z.object({
  saleId: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  date: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  items: z
    .array(
      z.object({
        itemId: z.string().uuid().optional().nullable(),
        itemName: z.string().trim().min(1).max(200),
        quantity: z.coerce.number().finite().positive(),
        rate: z.coerce.number().finite().min(0),
        taxAmount: z.coerce.number().finite().min(0).optional(),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * GET /sale-returns
 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const result = await saleReturnsService.listSaleReturns(
      req.businessId!,
      query.page,
      query.limit,
      query.search,
    );

    return res.json({
      success: true,
      ...result,
    });
  }),
);

/**
 * POST /sale-returns
 */
router.post(
  "/",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const parsed = createSaleReturnSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
        400,
      );
    }

    const result = await saleReturnsService.createSaleReturn(
      req.businessId!,
      parsed.data,
    );

    return res.status(201).json({
      success: true,
      data: result,
    });
  }),
);

/**
 * GET /sale-returns/:id
 */
router.get(
  "/:id",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    if (!z.string().uuid().safeParse(id).success) {
      throw new AppError("Invalid sale return ID", 400);
    }

    const result = await saleReturnsService.getSaleReturnById(
      req.businessId!,
      id,
    );

    return res.json({
      success: true,
      data: result,
    });
  }),
);

export default router;