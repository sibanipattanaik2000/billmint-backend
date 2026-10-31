/**
 * Development seed script
 * Creates demo account: admin / Admin@12345
 * NEVER use these credentials in production.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Decimal } from 'decimal.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding BillMint demo data...');

  // Permissions
  const perms = [
    { code: 'dashboard.view', name: 'View Dashboard', module: 'dashboard' },
    { code: 'sales.view', name: 'View Sales', module: 'sales' },
    { code: 'sales.create', name: 'Create Sales', module: 'sales' },
    { code: 'sales.edit', name: 'Edit Sales', module: 'sales' },
    { code: 'sales.delete', name: 'Delete Sales', module: 'sales' },
    { code: 'purchases.view', name: 'View Purchases', module: 'purchases' },
    { code: 'purchases.create', name: 'Create Purchases', module: 'purchases' },
    { code: 'customers.view', name: 'View Customers', module: 'customers' },
    { code: 'customers.create', name: 'Create Customers', module: 'customers' },
    { code: 'customers.edit', name: 'Edit Customers', module: 'customers' },
    { code: 'suppliers.view', name: 'View Suppliers', module: 'suppliers' },
    { code: 'suppliers.create', name: 'Create Suppliers', module: 'suppliers' },
    { code: 'items.view', name: 'View Items', module: 'items' },
    { code: 'items.create', name: 'Create Items', module: 'items' },
    { code: 'items.edit', name: 'Edit Items', module: 'items' },
    { code: 'inventory.view', name: 'View Inventory', module: 'inventory' },
    { code: 'inventory.adjust', name: 'Adjust Stock', module: 'inventory' },
    { code: 'expenses.view', name: 'View Expenses', module: 'expenses' },
    { code: 'expenses.create', name: 'Create Expenses', module: 'expenses' },
    { code: 'payments.view', name: 'View Payments', module: 'payments' },
    { code: 'payments.create', name: 'Create Payments', module: 'payments' },
    { code: 'reports.view', name: 'View Reports', module: 'reports' },
    { code: 'gst.view', name: 'View GST', module: 'gst' },
    { code: 'settings.view', name: 'View Settings', module: 'settings' },
    { code: 'settings.edit', name: 'Edit Settings', module: 'settings' },
    { code: 'users.view', name: 'View Users', module: 'users' },
    { code: 'users.manage', name: 'Manage Users', module: 'users' },
    { code: 'import.use', name: 'Import Data', module: 'import' },
    { code: 'export.use', name: 'Export Data', module: 'export' },
  ];

  for (const p of perms) {
    await prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} });
  }

  const allPerms = await prisma.permission.findMany();
  const passwordHash = await bcrypt.hash('Admin@12345', 12);

  // Check if already seeded
  const existing = await prisma.user.findUnique({ where: { userId: 'admin' } });
  if (existing) {
    console.log('Demo account already exists. Skipping seed.');
    return;
  }

  const user = await prisma.user.create({
    data: {
      userId: 'admin',
      passwordHash,
      name: 'Demo Owner',
      email: 'admin@BillMint.demo',
      phone: '9876543210',
    },
  });

  const business = await prisma.business.create({
    data: {
      name: 'Demo Traders',
      ownerName: 'Demo Owner',
      email: 'admin@BillMint.demo',
      phone: '9876543210',
      gstin: '29AABCT1332L1ZV',
      pan: 'AABCT1332L',
      address: '123 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pinCode: '560001',
      country: 'India',
      businessType: 'Retail',
      setupCompleted: true,
    },
  });

  const ownerRole = await prisma.role.create({
    data: {
      businessId: business.id,
      name: 'Owner',
      isSystem: true,
      permissions: { create: allPerms.map((p) => ({ permissionId: p.id })) },
    },
  });

  await prisma.businessMember.create({
    data: {
      businessId: business.id,
      userId: user.id,
      roleId: ownerRole.id,
      isOwner: true,
    },
  });

  await prisma.businessSettings.create({ data: { businessId: business.id } });

  for (const [type, prefix] of [
    ['invoice', 'INV'],
    ['quotation', 'QT'],
    ['challan', 'DC'],
    ['purchase', 'PUR'],
  ] as const) {
    await prisma.invoiceSequence.create({
      data: { businessId: business.id, type, prefix, nextNumber: 1 },
    });
  }

  // Units
  const unitPcs = await prisma.unit.create({
    data: { businessId: business.id, name: 'Piece', shortName: 'Pcs' },
  });
  await prisma.unit.create({
    data: { businessId: business.id, name: 'Kilogram', shortName: 'Kg' },
  });

  // Categories
  const catElectronics = await prisma.itemCategory.create({
    data: { businessId: business.id, name: 'Electronics' },
  });
  const catGrocery = await prisma.itemCategory.create({
    data: { businessId: business.id, name: 'Grocery' },
  });

  // Expense categories
  for (const name of ['Rent', 'Salary', 'Electricity', 'Transport', 'Internet', 'Marketing', 'Office', 'Maintenance', 'Other']) {
    await prisma.expenseCategory.create({
      data: { businessId: business.id, name, isSystem: true },
    });
  }

  // Cash account
  await prisma.bankAccount.create({
    data: {
      businessId: business.id,
      name: 'Cash',
      isCash: true,
      openingBalance: new Decimal(50000) as any,
      currentBalance: new Decimal(50000) as any,
    },
  });

  await prisma.bankAccount.create({
    data: {
      businessId: business.id,
      name: 'HDFC Current',
      accountNumber: '50200012345678',
      ifsc: 'HDFC0001234',
      bankName: 'HDFC Bank',
      openingBalance: new Decimal(150000) as any,
      currentBalance: new Decimal(150000) as any,
    },
  });

  // Customers
  const customers = await Promise.all([
    prisma.customer.create({
      data: {
        businessId: business.id,
        name: 'Rajesh Kumar',
        phone: '9812345678',
        city: 'Bengaluru',
        state: 'Karnataka',
        gstin: '29AABCR1234A1Z5',
        openingBalance: new Decimal(0) as any,
        currentBalance: new Decimal(0) as any,
      },
    }),
    prisma.customer.create({
      data: {
        businessId: business.id,
        name: 'Priya Traders',
        businessName: 'Priya Traders Pvt Ltd',
        phone: '9823456789',
        city: 'Mumbai',
        state: 'Maharashtra',
        openingBalance: new Decimal(5000) as any,
        currentBalance: new Decimal(5000) as any,
      },
    }),
    prisma.customer.create({
      data: {
        businessId: business.id,
        name: 'Amit Sharma',
        phone: '9834567890',
        city: 'Bengaluru',
        state: 'Karnataka',
      },
    }),
  ]);

  // Suppliers
  await prisma.supplier.create({
    data: {
      businessId: business.id,
      name: 'Wholesale Distributors',
      phone: '9900112233',
      city: 'Bengaluru',
      state: 'Karnataka',
      gstin: '29AABCW5678B1Z9',
    },
  });

  // Items
  const items = await Promise.all([
    prisma.item.create({
      data: {
        businessId: business.id,
        name: 'USB Cable Type-C',
        sku: 'USB-TC-01',
        barcode: '8901234567890',
        categoryId: catElectronics.id,
        unitId: unitPcs.id,
        purchasePrice: new Decimal(50) as any,
        salePrice: new Decimal(99) as any,
        mrp: new Decimal(149) as any,
        openingStock: new Decimal(100) as any,
        currentStock: new Decimal(100) as any,
        minimumStock: new Decimal(20) as any,
        gstRate: new Decimal(18) as any,
        hsnSac: '8544',
      },
    }),
    prisma.item.create({
      data: {
        businessId: business.id,
        name: 'Wireless Mouse',
        sku: 'WM-01',
        barcode: '8901234567891',
        categoryId: catElectronics.id,
        unitId: unitPcs.id,
        purchasePrice: new Decimal(250) as any,
        salePrice: new Decimal(499) as any,
        mrp: new Decimal(699) as any,
        openingStock: new Decimal(50) as any,
        currentStock: new Decimal(50) as any,
        minimumStock: new Decimal(10) as any,
        gstRate: new Decimal(18) as any,
        hsnSac: '8471',
      },
    }),
    prisma.item.create({
      data: {
        businessId: business.id,
        name: 'Basmati Rice 1kg',
        sku: 'RICE-1KG',
        barcode: '8901234567892',
        categoryId: catGrocery.id,
        unitId: unitPcs.id,
        purchasePrice: new Decimal(80) as any,
        salePrice: new Decimal(120) as any,
        mrp: new Decimal(140) as any,
        openingStock: new Decimal(200) as any,
        currentStock: new Decimal(200) as any,
        minimumStock: new Decimal(30) as any,
        gstRate: new Decimal(5) as any,
        hsnSac: '1006',
      },
    }),
  ]);

  // Opening stock movements
  for (const item of items) {
    await prisma.stockMovement.create({
      data: {
        businessId: business.id,
        itemId: item.id,
        type: 'OPENING',
        quantityIn: item.openingStock as any,
        balance: item.currentStock as any,
        notes: 'Opening stock',
      },
    });
  }

  console.log('Seed completed successfully!');
  console.log('');
  console.log('  Demo Login Credentials (DEVELOPMENT ONLY):');
  console.log('  User ID:  admin');
  console.log('  Password: Admin@12345');
  console.log('');
  console.log(`  Business: ${business.name}`);
  console.log(`  Customers: ${customers.length}`);
  console.log(`  Items: ${items.length}`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    throw error;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
