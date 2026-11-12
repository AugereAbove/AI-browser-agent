import { z } from 'zod';

export const fixtureVariantSchema = z.enum(['standard', 'changed-css', 'delayed-content']);
export type FixtureVariant = z.infer<typeof fixtureVariantSchema>;
