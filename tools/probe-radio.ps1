<#
  Sends read-only GAIA queries to a radio over its Bluetooth SPP serial port
  and prints the raw frames, for checking a radio against docs/bluetooth.md
  without any of the project's own code in the way.

  On Windows a paired radio's SPP service appears as a COM port; find it with
    Get-CimInstance Win32_PnPEntity | ? { $_.Name -match '\(COM\d+\)' }

    .\tools\probe-radio.ps1 -Port COM3

  Output is one line per command: NAME|sent-hex|received-hex
#>
param([string]$Port = 'COM3')
# All read-only queries. Nothing here keys the transmitter or writes settings.
$cmds = @(
  @{ n='GET_DEV_ID';    g=2; c=1;  d=@() },
  @{ n='GET_DEV_INFO';  g=2; c=4;  d=@(3) },
  @{ n='READ_STATUS';   g=2; c=5;  d=@(1) },
  @{ n='GET_HT_STATUS'; g=2; c=20; d=@() },
  @{ n='GET_VOLUME';    g=2; c=22; d=@() }
)
$sp = New-Object System.IO.Ports.SerialPort $Port,115200,'None',8,'One'
$sp.ReadTimeout = 2000; $sp.WriteTimeout = 2000
try {
  $sp.Open()
  foreach ($x in $cmds) {
    $body = @( [byte](($x.g -shr 8) -band 0xFF), [byte]($x.g -band 0xFF),
               [byte](($x.c -shr 8) -band 0xFF), [byte]($x.c -band 0xFF) ) + $x.d
    $frame = [byte[]](@(0xFF,0x01,0x00,[byte]$x.d.Count) + $body)
    $sp.DiscardInBuffer()
    $sp.Write($frame, 0, $frame.Length)
    Start-Sleep -Milliseconds 700
    $n = $sp.BytesToRead
    if ($n -gt 0) {
      $buf = New-Object byte[] $n
      $sp.Read($buf, 0, $n) | Out-Null
      Write-Output "$($x.n)|$([BitConverter]::ToString($frame))|$([BitConverter]::ToString($buf))"
    } else { Write-Output "$($x.n)|$([BitConverter]::ToString($frame))|(no reply)" }
  }
} catch { Write-Output "ERROR|$($_.Exception.Message)" }
finally { if ($sp.IsOpen) { $sp.Close() } }
