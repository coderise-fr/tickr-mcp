import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "plugins/tickr/hooks/dist/**"] },
  ...tseslint.configs.recommended,
);
