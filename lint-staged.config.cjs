// lint-staged.config.cjs — PR 1.4 (SEO)
// Staged files are passed as absolute paths by Husky.
module.exports = {
  '*.js': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
