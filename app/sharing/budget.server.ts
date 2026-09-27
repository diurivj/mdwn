/* Request-local D1 instrumentation for the sharing resource. This counts ACTUAL
 * prepared executions (including Session/proof reads and all batch statements),
 * not just the number of statements in a lifecycle transaction. No module-level
 * request state, query text, or parameters are retained or logged. */
export type SharingBudget = { queries: number; maxBindings: number };

export function sharingBudget(db: D1Database): { db: D1Database; budget: SharingBudget } {
  const budget: SharingBudget = { queries: 0, maxBindings: 0 };
  const wrapped = new WeakMap<object, { stmt: D1PreparedStatement; params: number }>();
  function charge(params: number): void {
    if (++budget.queries > 50 || params > 100) throw new Error("sharing D1 budget exceeded");
    budget.maxBindings = Math.max(budget.maxBindings, params);
  }
  function statement(stmt: D1PreparedStatement, params = 0): D1PreparedStatement {
    const proxy = new Proxy(stmt, { get(target, property) {
      if (property === "bind") return (...args: unknown[]) => statement(target.bind(...args), args.length);
      if (["run", "all", "first", "raw"].includes(String(property))) {
        return (...args: unknown[]) => {
          charge(params);
          const method = Reflect.get(target, property) as (...args: unknown[]) => unknown;
          return method.apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    wrapped.set(proxy, { stmt, params });
    return proxy;
  }
  const proxy = new Proxy(db, { get(target, property) {
    if (property === "prepare") return (query: string) => statement(target.prepare(query));
    if (property === "batch") return (statements: D1PreparedStatement[]) => {
      const original = statements.map((prepared) => {
        const entry = wrapped.get(prepared);
        if (!entry) throw new Error("unmeasured sharing D1 statement");
        charge(entry.params);
        return entry.stmt;
      });
      return target.batch(original);
    };
    // Sharing requests never use unmetered raw SQL execution.
    if (property === "exec") return () => { throw new Error("unmeasured sharing D1 execution"); };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db: proxy, budget };
}
