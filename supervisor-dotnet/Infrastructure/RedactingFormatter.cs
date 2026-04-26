using System.Text.RegularExpressions;
using Serilog.Events;
using Serilog.Formatting;

namespace Sensorium.Supervisor.Infrastructure;

/// <summary>
/// Wraps another <see cref="ITextFormatter"/> and masks Telegram bot tokens
/// (e.g. <c>bot123456:ABC-xyz</c> → <c>bot***</c>) before writing.
/// </summary>
public sealed partial class RedactingFormatter(ITextFormatter inner) : ITextFormatter
{
	[GeneratedRegex(@"bot\d+:[A-Za-z0-9_-]+", RegexOptions.Compiled)]
	private static partial Regex TokenPattern();

	public void Format(LogEvent logEvent, TextWriter output)
	{
		using var sw = new StringWriter();
		inner.Format(logEvent, sw);
		output.Write(TokenPattern().Replace(sw.ToString(), "bot***"));
	}
}
