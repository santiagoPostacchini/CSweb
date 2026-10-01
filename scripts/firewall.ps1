# Crea reglas de entrada en el Firewall de Windows para la web (TCP) y el trafico WebRTC (UDP).
$root = Split-Path -Parent $PSScriptRoot
$httpPort = 27016
$webrtcPort = 27018
$cfgPath = Join-Path $root 'config.json'
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.httpPort) { $httpPort = $cfg.httpPort }
    if ($cfg.webrtcPort) { $webrtcPort = $cfg.webrtcPort }
}

$rules = @(
    @{ Name = 'CS16 Web - pagina (TCP)'; Protocol = 'TCP'; Port = $httpPort },
    @{ Name = 'CS16 Web - juego WebRTC (UDP)'; Protocol = 'UDP'; Port = $webrtcPort }
)
foreach ($r in $rules) {
    Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
        -Protocol $r.Protocol -LocalPort $r.Port -Profile Any | Out-Null
    Write-Host "OK: $($r.Name) puerto $($r.Port)"
}

$blocked = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
    Where-Object { $_.Program -like '*node.exe' } |
    Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
if ($blocked) {
    Write-Host ''
    Write-Host 'ATENCION: hay reglas que BLOQUEAN node.exe (suelen crearse al cancelar el aviso del firewall):' -ForegroundColor Yellow
    $blocked | ForEach-Object { Write-Host "  - $($_.DisplayName)" }
    Write-Host 'Deshabilitalas desde "Firewall de Windows con seguridad avanzada" > Reglas de entrada.' -ForegroundColor Yellow
}
