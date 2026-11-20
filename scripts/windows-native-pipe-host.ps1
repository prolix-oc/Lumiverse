# Exercise the same Windows launch conditions as the Rust tray. Bun.spawn's
# libuv pipes and inherited console do not cover CreateProcess + anonymous
# standard handles + CREATE_NO_WINDOW. Forward bytes without decoding them.
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 emits a JSON array as one pipeline object. Wrapping it
# in @() would add another array and make every valid command have length 1.
$launch = ConvertFrom-Json $env:LUMIVERSE_NATIVE_SMOKE_COMMAND
if ($launch.Length -lt 2) { throw 'Missing native smoke command' }
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public static class NativePipeHost {
    // ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
    private static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            slashes = 0;
            result.Append(ch);
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    public static int Run(string executable, string[] arguments) {
        var quoted = new string[arguments.Length];
        for (int index = 0; index < arguments.Length; index++) quoted[index] = Quote(arguments[index]);
        using (var process = new Process()) {
            process.StartInfo = new ProcessStartInfo {
                FileName = executable,
                Arguments = string.Join(" ", quoted),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            process.Start();
            Task.Run(() => {
                try { Console.OpenStandardInput().CopyTo(process.StandardInput.BaseStream); }
                catch (IOException) { }
                finally { try { process.StandardInput.Close(); } catch (InvalidOperationException) { } }
            });
            var stdout = Task.Run(() => process.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
            var stderr = Task.Run(() => process.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
            process.WaitForExit();
            Task.WaitAll(stdout, stderr);
            return process.ExitCode;
        }
    }
}
'@
[Environment]::Exit([NativePipeHost]::Run($launch[0], [string[]]$launch[1..($launch.Length - 1)]))
