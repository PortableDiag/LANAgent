/**
 * Filter, sort and (optionally) paginate revenue/expense records for GET /api/revenue/records.
 *
 * Pagination is opt-in: the dashboard's three revenue views call /records with no query and
 * render every row (then filter by type client-side), so an unasked-for default page size would
 * silently drop older records from them. Supplying `page` or `limit` turns paging on.
 *
 * Throws { status: 400 } on an unparseable date rather than filtering everything away.
 */
export const SORTABLE_FIELDS = ['timestamp', 'usdValue', 'type', 'category', 'network'];

export function queryRevenueRecords(records, query = {}) {
  const { page, limit, sortBy = 'timestamp', sortOrder = 'desc', type, category, network, startDate, endDate } = query;

  const parseDate = (v, name) => {
    const t = new Date(v).getTime();
    if (Number.isNaN(t)) {
      const err = new Error(`Invalid ${name}: ${v}`);
      err.status = 400;
      throw err;
    }
    return t;
  };
  const start = startDate ? parseDate(startDate, 'startDate') : null;
  const end = endDate ? parseDate(endDate, 'endDate') : null;

  let rows = (records || []).filter(r =>
    (!type || !['revenue', 'expense'].includes(type) || r.type === type) &&
    (!category || r.category === category) &&
    (!network || r.network === network) &&
    (start === null || r.timestamp >= start) &&
    (end === null || r.timestamp <= end));

  const field = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'timestamp';
  const dir = sortOrder === 'asc' ? 1 : -1;
  const key = (r) => {
    if (field === 'timestamp') return new Date(r.timestamp).getTime() || 0;
    if (field === 'usdValue') return Number(r.usdValue) || 0;
    return String(r[field] ?? '');
  };
  rows = rows.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    return x < y ? -dir : x > y ? dir : 0;
  });

  const total = rows.length;
  if (page === undefined && limit === undefined) {
    return { data: rows, pagination: null };
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit, 10) || 50));
  const totalPages = Math.ceil(total / limitNum);
  return {
    data: rows.slice((pageNum - 1) * limitNum, pageNum * limitNum),
    pagination: { page: pageNum, limit: limitNum, total, totalPages, hasNextPage: pageNum < totalPages, hasPrevPage: pageNum > 1 }
  };
}
