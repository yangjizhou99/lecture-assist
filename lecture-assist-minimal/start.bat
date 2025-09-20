@echo off
echo 讲座助手启动脚本
echo ==================

echo 检查Node.js安装...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误：未找到Node.js，请先安装Node.js
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js已安装，版本：
node --version

echo.
echo 检查环境变量文件...
if not exist "server\.env" (
    echo 警告：未找到.env文件，请先配置API密钥
    echo 请参考"启动说明.md"文件
    pause
    exit /b 1
)

echo.
echo 安装依赖包...
cd server
call npm install
if %errorlevel% neq 0 (
    echo 错误：依赖安装失败
    pause
    exit /b 1
)

echo.
echo 启动服务器...
echo 服务器将在 http://localhost:4350 启动
echo 按 Ctrl+C 停止服务器
echo.
call npm run dev

pause

