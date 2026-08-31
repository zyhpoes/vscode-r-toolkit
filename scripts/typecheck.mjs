// 全项目类型检查的包装脚本。
// 背景：lint-staged 会把暂存文件追加到命令末尾（如 `tsc --noEmit xxx.ts`），
// 而 tsc 一旦带文件参数就会忽略 tsconfig.json（改用默认配置），导致误报。
// 这里用包装脚本丢弃多余参数，保证 tsc 始终走 tsconfig.json 做全项目检查。
import { execSync } from 'node:child_process';

execSync('tsc --noEmit', { stdio: 'inherit' });
