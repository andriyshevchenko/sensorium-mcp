using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Services;

public sealed class TelegramNotifier : ITelegramNotifier
{
    private readonly HttpClient _http;
    private readonly string? _token;
    private readonly string? _chatId;
    private readonly ILogger<TelegramNotifier> _log;

    public TelegramNotifier(IHttpClientFactory factory, IOptions<SupervisorOptions> opts, ILogger<TelegramNotifier> log)
    {
        _http = factory.CreateClient("telegram");
        _http.Timeout = TimeSpan.FromSeconds(10);
        _token = opts.Value.TelegramToken;
        _chatId = opts.Value.TelegramChatId;
        _log = log;
    }

    public async Task NotifyAsync(string text, int threadId = 0, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(_token) || string.IsNullOrEmpty(_chatId))
        {
            _log.LogDebug("NotifyOperator: skipped (no Telegram credentials)");
            return;
        }

        _log.LogDebug("NotifyOperator: sending to chat {ChatId} (threadId={ThreadId})", _chatId, threadId);

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));

            var url = $"https://api.telegram.org/bot{_token}/sendMessage";
            var payload = new Dictionary<string, object>
            {
                ["chat_id"] = _chatId,
                ["text"] = text,
                ["parse_mode"] = "HTML"
            };
            if (threadId > 0)
                payload["message_thread_id"] = threadId;

            using var resp = await _http.PostAsJsonAsync(url, payload, cts.Token).ConfigureAwait(false);
            if ((int)resp.StatusCode >= 400)
                _log.LogWarning("Telegram notify: HTTP {Status}", (int)resp.StatusCode);
            else
                _log.LogDebug("Telegram notify: sent OK (HTTP {Status})", (int)resp.StatusCode);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Telegram notify failed");
        }
    }
}
