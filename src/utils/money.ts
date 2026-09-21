import Decimal from 'decimal.js';

// Configure Decimal for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function toDecimal(value: number | string | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value);
}

export function roundMoney(value: Decimal | number | string, places = 2): Decimal {
  return toDecimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

export function formatMoney(value: Decimal | number | string, symbol = '₹'): string {
  const d = roundMoney(value);
  return `${symbol}${d.toFixed(2)}`;
}

/**
 * Calculate line item amounts for GST invoice
 */
export function calculateLineItem(params: {
  quantity: number | string;
  rate: number | string;
  discountPercent?: number | string;
  gstRate?: number | string;
  isInterState?: boolean;
}) {
  const qty = toDecimal(params.quantity);
  const rate = toDecimal(params.rate);
  const discountPct = toDecimal(params.discountPercent || 0);
  const gstRate = toDecimal(params.gstRate || 0);
  const isInterState = params.isInterState ?? false;

  const gross = qty.mul(rate);
  const discountAmount = roundMoney(gross.mul(discountPct).div(100));
  const taxableAmount = roundMoney(gross.minus(discountAmount));

  let cgstAmount = new Decimal(0);
  let sgstAmount = new Decimal(0);
  let igstAmount = new Decimal(0);

  if (gstRate.gt(0)) {
    if (isInterState) {
      igstAmount = roundMoney(taxableAmount.mul(gstRate).div(100));
    } else {
      const halfRate = gstRate.div(2);
      cgstAmount = roundMoney(taxableAmount.mul(halfRate).div(100));
      sgstAmount = roundMoney(taxableAmount.mul(halfRate).div(100));
    }
  }

  const taxTotal = cgstAmount.plus(sgstAmount).plus(igstAmount);
  const amount = roundMoney(taxableAmount.plus(taxTotal));

  return {
    quantity: qty,
    rate,
    discountPercent: discountPct,
    discountAmount,
    taxableAmount,
    gstRate,
    cgstAmount,
    sgstAmount,
    igstAmount,
    amount,
  };
}

/**
 * Aggregate invoice totals from line items
 */
export function calculateInvoiceTotals(
  items: ReturnType<typeof calculateLineItem>[],
  roundOffEnabled = true
) {
  let subtotal = new Decimal(0);
  let discountAmount = new Decimal(0);
  let taxableAmount = new Decimal(0);
  let cgstAmount = new Decimal(0);
  let sgstAmount = new Decimal(0);
  let igstAmount = new Decimal(0);

  for (const item of items) {
    subtotal = subtotal.plus(item.quantity.mul(item.rate));
    discountAmount = discountAmount.plus(item.discountAmount);
    taxableAmount = taxableAmount.plus(item.taxableAmount);
    cgstAmount = cgstAmount.plus(item.cgstAmount);
    sgstAmount = sgstAmount.plus(item.sgstAmount);
    igstAmount = igstAmount.plus(item.igstAmount);
  }

  subtotal = roundMoney(subtotal);
  discountAmount = roundMoney(discountAmount);
  taxableAmount = roundMoney(taxableAmount);
  cgstAmount = roundMoney(cgstAmount);
  sgstAmount = roundMoney(sgstAmount);
  igstAmount = roundMoney(igstAmount);

  const beforeRound = taxableAmount.plus(cgstAmount).plus(sgstAmount).plus(igstAmount);
  let roundOff = new Decimal(0);
  let grandTotal = beforeRound;

  if (roundOffEnabled) {
    grandTotal = roundMoney(beforeRound, 0); // round to nearest rupee
    roundOff = roundMoney(grandTotal.minus(beforeRound));
  } else {
    grandTotal = roundMoney(beforeRound);
  }

  return {
    subtotal,
    discountAmount,
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    cessAmount: new Decimal(0),
    roundOff,
    grandTotal,
  };
}

/**
 * Amount in words (Indian numbering)
 */
export function amountInWords(amount: number | string | Decimal): string {
  const num = Math.floor(toDecimal(amount).toNumber());
  if (num === 0) return 'Zero Rupees Only';

  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function convertLessThanThousand(n: number): string {
    if (n === 0) return '';
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + convertLessThanThousand(n % 100) : '');
  }

  let result = '';
  const crore = Math.floor(num / 10000000);
  const lakh = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const remainder = num % 1000;

  if (crore) result += convertLessThanThousand(crore) + ' Crore ';
  if (lakh) result += convertLessThanThousand(lakh) + ' Lakh ';
  if (thousand) result += convertLessThanThousand(thousand) + ' Thousand ';
  if (remainder) result += convertLessThanThousand(remainder);

  return result.trim() + ' Rupees Only';
}
