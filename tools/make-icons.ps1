# Генерирует иконки расширения (16/32/48/128 px) без внешних зависимостей.
# Запуск один раз из корня проекта:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$accent = [System.Drawing.Color]::FromArgb(255, 76, 110, 245)   # синий фон
$glyph  = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)  # белая луна

foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)

    # Скруглённый квадрат-подложка
    $r = [Math]::Max(3, [int]($size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $bg = New-Object System.Drawing.SolidBrush($accent)
    $g.FillPath($bg, $path)

    # Полумесяц: большой белый круг минус смещённый круг цвета фона
    $moon = $size * 0.62
    $mx = ($size - $moon) / 2
    $my = ($size - $moon) / 2
    $fg = New-Object System.Drawing.SolidBrush($glyph)
    $g.FillEllipse($fg, $mx, $my, $moon, $moon)
    $cut = $moon * 0.86
    $g.FillEllipse($bg, $mx + $moon * 0.30, $my - $moon * 0.16, $cut, $cut)

    $file = Join-Path $outDir "icon$size.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)

    $fg.Dispose(); $bg.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()
    Write-Host "created $file"
}
