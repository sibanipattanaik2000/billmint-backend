import { Router, Response } from 'express';
import authRoutes from './auth.routes';
import { authenticate, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

import * as dashboardService from '../services/dashboard.service';
import * as customersService from '../services/customers.service';
import * as itemsService from '../services/items.service';
import * as salesService from '../services/sales.service';
import purchasesRoutes from './purchases.routes';
import suppliersRoutes from "./suppliers.routes";
import expensesRoutes from "./expenses.routes";
import otherIncomeRoutes from "./other-income.routes";
import paymentsRoutes from "./payments.routes";
import bankAccountsRoutes from "./bank-accounts.routes";
import quotationsRoutes from "./quotations.routes";
import deliveryChallansRoutes from "./delivery-challans.routes";
import saleReturnsRoutes from "./sale-returns.routes";
import {
  customerSchema,
  itemSchema,
  saleSchema,
  paginationSchema,
} from '../validators/common';
import prisma from '../utils/prisma';

const router = Router();

router.use('/auth', authRoutes);
router.use('/purchases', purchasesRoutes);
router.use("/suppliers", suppliersRoutes);
router.use("/expenses", expensesRoutes);
router.use("/other-income", otherIncomeRoutes);
router.use("/payments", paymentsRoutes);
router.use("/cash-bank", bankAccountsRoutes);
router.use("/quotations", quotationsRoutes);
router.use("/delivery-challans", deliveryChallansRoutes);
router.use("/sale-returns", saleReturnsRoutes);
/* =========================================================
   DASHBOARD
========================================================= */

router.get(
  '/dashboard',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await dashboardService.getDashboard(req.businessId!);

    res.json({
      success: true,
      data,
    });
  })
);

/* =========================================================
   CUSTOMERS
========================================================= */

router.get(
  '/customers',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const data = await customersService.listCustomers(
      req.businessId!,
      query
    );

    res.json({
      success: true,
      ...data,
    });
  })
);

router.post(
  '/customers',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = customerSchema.parse(req.body);

    const data = await customersService.createCustomer(
      req.businessId!,
      body,
      req.user?.userId
    );

    res.status(201).json({
      success: true,
      data,
    });
  })
);

router.get(
  '/customers/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await customersService.getCustomer(
      req.businessId!,
      id
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.patch(
  '/customers/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const body = customerSchema.partial().parse(req.body);

    const data = await customersService.updateCustomer(
      req.businessId!,
      id,
      body,
      req.user?.userId
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.delete(
  '/customers/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await customersService.deleteCustomer(
      req.businessId!,
      id,
      req.user?.userId
    );

    res.json({
      success: true,
      data,
    });
  })
);

/* =========================================================
   ITEMS
========================================================= */

router.get(
  '/items',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const categoryId =
      typeof req.query.categoryId === 'string'
        ? req.query.categoryId
        : undefined;

    const lowStock =
      req.query.lowStock === 'true';

    const data = await itemsService.listItems(
      req.businessId!,
      {
        ...query,
        categoryId,
        lowStock,
      }
    );

    res.json({
      success: true,
      ...data,
    });
  })
);

router.post(
  '/items',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = itemSchema.parse(req.body);

    const data = await itemsService.createItem(
      req.businessId!,
      body,
      req.user?.userId
    );

    res.status(201).json({
      success: true,
      data,
    });
  })
);

router.get(
  '/items/barcode/:barcode',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const barcode = String(req.params.barcode);

    const data = await itemsService.searchByBarcode(
      req.businessId!,
      barcode
    );

    res.json({
      success: true,
      data,
    });
  })
);
router.get(
  '/items/code/:sku',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.searchBySku(
      req.businessId!,
      String(req.params.sku)
    );

    res.json({ success: true, data });
  })
);
router.get(
  "/items/imei/:imei",
  authenticate,
  asyncHandler(
    async (
      req: AuthRequest,
      res: Response,
    ) => {
      const data =
        await itemsService.searchByImei(
          req.businessId!,
          String(req.params.imei),
        );

      res.json({
        success: true,
        data,
      });
    },
  ),
);
router.get(
  '/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await itemsService.getItem(
      req.businessId!,
      id
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.patch(
  '/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    const body = itemSchema.partial().parse(req.body);

    const data = await itemsService.updateItem(
      req.businessId!,
      id,
      body,
      req.user?.userId
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.delete(
  '/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await itemsService.deleteItem(
      req.businessId!,
      id,
      req.user?.userId
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.post(
  '/items/:id/adjust-stock',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const {
      quantity,
      reason,
      notes,
    } = req.body;

    const data = await itemsService.adjustStock(
      req.businessId!,
      id,
      quantity,
      reason,
      notes,
      req.user?.userId
    );

    res.json({
      success: true,
      data,
    });
  })
);

/* =========================================================
   SALES
========================================================= */

router.get(
  '/sales',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);

    const status =
      typeof req.query.status === 'string'
        ? req.query.status
        : undefined;

    const from =
      typeof req.query.from === 'string'
        ? new Date(req.query.from)
        : undefined;

    const to =
      typeof req.query.to === 'string'
        ? new Date(req.query.to)
        : undefined;

    if (from && Number.isNaN(from.getTime())) {
      throw new Error('Invalid from date');
    }

    if (to && Number.isNaN(to.getTime())) {
      throw new Error('Invalid to date');
    }

    const data = await salesService.getSales(
      req.businessId!,
      {
        ...query,
        status,
        from,
        to,
      }
    );

    res.json({
      success: true,
      ...data,
    });
  })
);

router.post(
  '/sales',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = saleSchema.parse(req.body);

    const data = await salesService.createSale(
      req.businessId!,
      {
        ...body,
        createdById: req.user?.userId,
      }
    );

    res.status(201).json({
      success: true,
      data,
    });
  })
);

router.get(
  '/sales/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await salesService.getSaleById(
      req.businessId!,
      id
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.post(
  '/sales/:id/cancel',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);

    const data = await salesService.cancelSale(
      req.businessId!,
      id,
      req.user?.userId
    );

    res.json({
      success: true,
      data,
    });
  })
);

/* =========================================================
   HEALTH
========================================================= */

router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const startedAt = Date.now();

    try {
      await prisma.$queryRaw`SELECT 1`;

      res.status(200).json({
        success: true,
        status: "healthy",
        message: "BillMint API is running",
        database: "connected",
        latencyMs: Date.now() - startedAt,
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "[HEALTH] Database check failed:",
        error,
      );

      res.status(503).json({
        success: false,
        status: "degraded",
        message: "BillMint API is running but database is unavailable",
        database: "disconnected",
        latencyMs: Date.now() - startedAt,
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    }
  }),
);

export default router;