using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Services;

public sealed class McpClient : IMcpClient
{
    private readonly HttpClient _http;
    private readonly ILogger<McpClient> _log;

    public McpClient(IHttpClientFactory factory, IOptions<SupervisorOptions> opts, ILogger<McpClient> log)
    {
        _log = log;
        _http = factory.CreateClient("mcp");
        _http.BaseAddress = new Uri($"http://127.0.0.1:{opts.Value.McpHttpPort}");
        _http.Timeout = TimeSpan.FromSeconds(30);

        if (!string.IsNullOrEmpty(opts.Value.McpHttpSecret))
            _http.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", opts.Value.McpHttpSecret);
    }

    public async Task<bool> IsServerReadyAsync(CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(3));

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Options, "/mcp");
            using var resp = await _http.SendAsync(req, cts.Token).ConfigureAwait(false);
            bool ready = (int)resp.StatusCode < 500;
            _log.LogDebug("IsServerReady: OPTIONS /mcp => {Status} (ready={Ready})", (int)resp.StatusCode, ready);
            return ready;
        }
        catch (Exception ex) when (ex is OperationCanceledException or HttpRequestException)
        {
            _log.LogDebug("IsServerReady: OPTIONS /mcp failed: {Message}", ex.Message);
            return false;
        }
    }

    public async Task<bool> WaitForReadyAsync(TimeSpan pollInterval, TimeSpan timeout, CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);

        using var timer = new PeriodicTimer(pollInterval);
        try
        {
            do
            {
                if (await IsServerReadyAsync(cts.Token).ConfigureAwait(false))
                    return true;
            }
            while (await timer.WaitForNextTickAsync(cts.Token).ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            // timeout or external cancel
        }

        return false;
    }

    public async Task<bool> PrepareShutdownAsync(CancellationToken ct = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(5));

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/prepare-shutdown");
            using var resp = await _http.SendAsync(req, cts.Token).ConfigureAwait(false);
            if ((int)resp.StatusCode >= 400)
            {
                _log.LogWarning("PrepareShutdown returned HTTP {Status}", (int)resp.StatusCode);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "PrepareShutdown request failed");
            return false;
        }
    }
}
