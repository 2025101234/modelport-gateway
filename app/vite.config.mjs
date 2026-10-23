import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from '@tailwindcss/vite'

const root = fileURLToPath(new URL('./ui', import.meta.url))

/**
 * 控制台前端的构建配置。
 *
 * 这里曾经还有一个虚拟模块，把内置的 75 家聚合提供商注册表（`src/providers/registry.json`）
 * 内联给「聚合渠道」页做筛选。那条车道已经移除，注册表与页面一起删了，插件也随之
 * 去掉——配置里不该留下一个指向不存在文件的读取。
 */
export default {
  root, base: '/assets/',
  plugins: [tailwind()],
  build: {
    outDir: fileURLToPath(new URL('./web', import.meta.url)),
    emptyOutDir: false, write: false, assetsDir: '', target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: asset => asset.names?.some(name => path.extname(name) === '.css') ? 'app.css' : '[name]-[hash][extname]',
      },
    },
  },
}