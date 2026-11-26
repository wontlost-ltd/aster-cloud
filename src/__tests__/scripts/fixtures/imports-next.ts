// image-deps-only-hook 的反例：直接导入镜像里没有的 next，钩子必须拒绝。
import { NextResponse } from 'next/server';

console.log(typeof NextResponse);
