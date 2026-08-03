-- 《历代纪》作者工作台启动器。
-- 只唤醒本机 Studio 并打开浏览器；不承载服务、不嵌入任何密码或私有数据。
on run
	try
		set scriptPath to (POSIX path of (path to resource "open-studio.sh"))
		do shell script quoted form of scriptPath
	on error errMsg
		display dialog "无法打开《历代纪》作者工作台。" & return & return & errMsg & return & return & "日志目录：~/Library/Logs/LidaijiStudio/" with title "历代纪作者工作台" with icon stop buttons {"知道了"} default button 1
	end try
end run
