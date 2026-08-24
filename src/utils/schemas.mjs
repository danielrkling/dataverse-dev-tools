import { z } from "zod";

/**
 * Drops empty values from a schema
 * @param {import("zod").ZodTypeAny} schema - The schema to transform
 * @returns {import("zod").ZodTypeAny} - The transformed schema
 */
function dropEmpty(schema) {
  return schema.transform((val) => {
    if (val === undefined) return undefined;
    if (Array.isArray(val) && val.length === 0) return undefined;
    if (
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      Object.keys(val).length === 0
    )
      return undefined;
    return val;
  });
}





