using Raven.Studio.Infrastructure;

namespace Raven.Studio.Commands
{
	public class NavigateToExternalUrlCommand : Command
	{
		private string href;

		public override bool CanExecute(object parameter)
		{
			href = parameter as string;
			return href != null;
		}

		public override void Execute(object parameter)
		{
		    UrlUtil.NavigateToExternal(href);
		}
	}
}