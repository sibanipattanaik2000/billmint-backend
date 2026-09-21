import { Router } from 'express';
import authRoutes from './auth.routes';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { Response } from 'express';
import * as dashboardService from '../services/dashboard.service';
import * as customersService from '../services/customers.service';
import * as itemsService from '../services/items.service';
import * as salesService from '../services/sales.service';
import { customerSchema, itemSchema, saleSchema, paginationSchema } from '../validators/common';

const router = Router();

router.use('/auth', authRoutes);

// Dashboard
router.get(
  '/dashboard',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await dashboardService.getDashboard(req.businessId!);
    res.json({ success: true, data });
  })
);

// Customers
router.get(
  '/customers',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const data = await customersService.listCustomers(req.businessId!, query);
    res.json({ success: true, ...data });
  })
);

router.post(
  '/customers',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = customerSchema.parse(req.body);
    const data = await customersService.createCustomer(req.businessId!, body, req.user?.userId);
    res.status(201).json({ success: true, data });
  })
);

router.get(
  '/customers/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await customersService.getCustomer(req.businessId!, req.params.id);
    res.json({ success: true, data });
  })
);

router.patch(
  '/customers/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = customerSchema.partial().parse(req.body);
    const data = await customersService.updateCustomer(
      req.businessId!,
      req.params.id,
      body,
      req.user?.userId
    );
    res.json({ success: true, data });
  })
);

router.delete(
  '/customers/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await customersService.deleteCustomer(
      req.businessId!,
      req.params.id,
      req.user?.userId
    );
    res.json({ success: true, data });
  })
);

// Items
router.get(
  '/items',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const data = await itemsService.listItems(req.businessId!, {
      ...query,
      categoryId: req.query.categoryId as string,
      lowStock: req.query.lowStock === 'true',
    });
    res.json({ success: true, ...data });
  })
);

router.post(
  '/items',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = itemSchema.parse(req.body);
    const data = await itemsService.createItem(req.businessId!, body, req.user?.userId);
    res.status(201).json({ success: true, data });
  })
);

router.get(
  '/items/barcode/:barcode',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.searchByBarcode(req.businessId!, req.params.barcode);
    res.json({ success: true, data });
  })
);

router.get(
  '/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.getItem(req.businessId!, req.params.id);
    res.json({ success: true, data });
  })
);

router.patch(
  '/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = itemSchema.partial().parse(req.body);
    const data = await itemsService.updateItem(
      req.businessId!,
      req.params.id,
      body,
      req.user?.userId
    );
    res.json({ success: true, data });
  })
);

router.delete(
  '/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await itemsService.deleteItem(req.businessId!, req.params.id, req.user?.userId);
    res.json({ success: true, data });
  })
);

router.post(
  '/items/:id/adjust-stock',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { quantity, reason, notes } = req.body;
    const data = await itemsService.adjustStock(
      req.businessId!,
      req.params.id,
      quantity,
      reason,
      notes,
      req.user?.userId
    );
    res.json({ success: true, data });
  })
);

// Sales
router.get(
  '/sales',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const data = await salesService.getSales(req.businessId!, {
      ...query,
      status: req.query.status as string,
      from: req.query.from ? new Date(req.query.from as string) : undefined,
      to: req.query.to ? new Date(req.query.to as string) : undefined,
    });
    res.json({ success: true, ...data });
  })
);

router.post(
  '/sales',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = saleSchema.parse(req.body);
    const data = await salesService.createSale(req.businessId!, {
      ...body,
      createdById: req.user?.userId,
    });
    res.status(201).json({ success: true, data });
  })
);

router.get(
  '/sales/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await salesService.getSaleById(req.businessId!, req.params.id);
    res.json({ success: true, data });
  })
);

router.post(
  '/sales/:id/cancel',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await salesService.cancelSale(req.businessId!, req.params.id, req.user?.userId);
    res.json({ success: true, data });
  })
);

// Health
router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'BillMint API is running', version: '1.0.0' });
});

export default router;
