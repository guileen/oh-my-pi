import "bun:sqlite";

declare module "bun:sqlite" {
	interface Database {
		/** Bun >=1.4.4 supports SQL functions; installed bun-types predates this used overload. */
		function(name: string, callback: () => number): this;
	}
}
