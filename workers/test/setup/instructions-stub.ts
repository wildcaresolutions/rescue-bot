// Vitest global setup: create minimal stubs for auto-generated modules so that
// tests don't blow up in fresh clones where `make cf-setup` hasn't been run.
//
// Stubs created:
//   src/instructions.ts  — exports COMBINED_INSTRUCTION (string)
//   src/guides.ts        — exports BUILTIN_GUIDES (Guide[])
//
// Both are gitignored and produced by:
//   node workers/scripts/gen-instructions.js
//   node workers/scripts/gen-guides.js
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'

export default function setup() {
  const srcDir = join(process.cwd(), 'src')

  const instructionsPath = join(srcDir, 'instructions.ts')
  if (!existsSync(instructionsPath)) {
    writeFileSync(
      instructionsPath,
      `// Auto-generated stub for tests. Real file produced by make cf-setup.\nexport const COMBINED_INSTRUCTION = '';\n`
    )
  }

  const guidesPath = join(srcDir, 'guides.ts')
  if (!existsSync(guidesPath)) {
    writeFileSync(
      guidesPath,
      `// Auto-generated stub for tests. Real file produced by make cf-setup.\nexport interface Guide { filename: string; name: string; category: string; text: string }\nexport const BUILTIN_GUIDES: Guide[] = [];\n`
    )
  }
}
