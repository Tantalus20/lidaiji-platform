#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

@interface AuthorAppDelegate : NSObject <NSApplicationDelegate>
@property NSWindow *window;
@property NSTextField *statusLabel;
@property NSMutableArray<NSButton *> *actionButtons;
@property NSString *rootPath;
@end

@implementation AuthorAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.actionButtons = [NSMutableArray array];
    NSString *rootFile = [[NSBundle mainBundle] pathForResource:@"root-path" ofType:@"txt"];
    NSString *rootContents = [NSString stringWithContentsOfFile:rootFile encoding:NSUTF8StringEncoding error:nil];
    self.rootPath = [(rootContents ?: @"") stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    [self buildWindow];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self runBridge:@[@"stop-preview"]];
}

- (void)buildWindow {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 520, 480)
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"历代纪写作";
    [self.window center];

    NSTextField *title = [NSTextField labelWithString:@"历代纪写作"];
    title.font = [NSFont systemFontOfSize:27 weight:NSFontWeightSemibold];
    title.alignment = NSTextAlignmentCenter;
    NSTextField *subtitle = [NSTextField labelWithString:@"选择 Word，剩下的交给网站"];
    subtitle.font = [NSFont systemFontOfSize:14];
    subtitle.textColor = NSColor.secondaryLabelColor;
    subtitle.alignment = NSTextAlignmentCenter;

    NSButton *import = [self button:@"导入 Word 文稿" action:@selector(importWord:)];
    import.keyEquivalent = @"\r";
    NSButton *preview = [self button:@"预览网站" action:@selector(previewSite:)];
    NSButton *publish = [self button:@"发布网站" action:@selector(publishSite:)];
    NSButton *backup = [self button:@"备份网站" action:@selector(backupSite:)];
    NSButton *incoming = [self button:@"打开 Word 来稿箱" action:@selector(openIncoming:)];
    NSButton *stop = [self button:@"停止本地预览" action:@selector(stopPreview:)];

    NSStackView *pair1 = [NSStackView stackViewWithViews:@[preview, publish]];
    pair1.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    pair1.spacing = 12;
    pair1.distribution = NSStackViewDistributionFillEqually;
    NSStackView *pair2 = [NSStackView stackViewWithViews:@[backup, incoming]];
    pair2.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    pair2.spacing = 12;
    pair2.distribution = NSStackViewDistributionFillEqually;

    self.statusLabel = [NSTextField labelWithString:@"就绪"];
    self.statusLabel.alignment = NSTextAlignmentCenter;
    self.statusLabel.textColor = NSColor.secondaryLabelColor;
    self.statusLabel.font = [NSFont systemFontOfSize:12];

    NSStackView *stack = [NSStackView stackViewWithViews:@[title, subtitle, import, pair1, pair2, stop, self.statusLabel]];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.spacing = 14;
    stack.edgeInsets = NSEdgeInsetsMake(30, 34, 26, 34);
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    self.window.contentView = [[NSView alloc] init];
    [self.window.contentView addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.leadingAnchor constraintEqualToAnchor:self.window.contentView.leadingAnchor],
        [stack.trailingAnchor constraintEqualToAnchor:self.window.contentView.trailingAnchor],
        [stack.topAnchor constraintEqualToAnchor:self.window.contentView.topAnchor],
        [stack.bottomAnchor constraintEqualToAnchor:self.window.contentView.bottomAnchor],
        [import.heightAnchor constraintEqualToConstant:48],
        [pair1.heightAnchor constraintEqualToConstant:42],
        [pair2.heightAnchor constraintEqualToConstant:42],
        [stop.heightAnchor constraintEqualToConstant:36]
    ]];
    [self.window makeKeyAndOrderFront:nil];
}

- (NSButton *)button:(NSString *)title action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.controlSize = NSControlSizeLarge;
    [self.actionButtons addObject:button];
    return button;
}

- (NSDictionary *)runBridge:(NSArray<NSString *> *)arguments {
    if (self.rootPath.length == 0) return @{@"ok": @NO, @"output": @"找不到网站项目目录，请重新安装桌面入口。"};
    NSTask *task = [[NSTask alloc] init];
    NSPipe *pipe = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:[self.rootPath stringByAppendingPathComponent:@"scripts/gui-bridge.sh"]];
    task.arguments = arguments;
    task.standardOutput = pipe;
    task.standardError = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return @{@"ok": @NO, @"output": error.localizedDescription ?: @"无法启动作者工具。"};
    [task waitUntilExit];
    NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
    NSString *output = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @""
                        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return @{@"ok": @(task.terminationStatus == 0), @"output": output};
}

- (NSDictionary<NSString *, NSString *> *)fields:(NSString *)output {
    NSMutableDictionary *values = [NSMutableDictionary dictionary];
    for (NSString *line in [output componentsSeparatedByString:@"\n"]) {
        NSRange tab = [line rangeOfString:@"\t"];
        if (tab.location != NSNotFound) values[[line substringToIndex:tab.location]] = [line substringFromIndex:tab.location + 1];
    }
    return values;
}

- (void)showAlert:(NSString *)title message:(NSString *)message critical:(BOOL)critical {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = message ?: @"";
    alert.alertStyle = critical ? NSAlertStyleCritical : NSAlertStyleInformational;
    [alert addButtonWithTitle:@"我知道了"];
    [alert runModal];
}

- (BOOL)confirm:(NSString *)title message:(NSString *)message accept:(NSString *)accept cancel:(NSString *)cancel {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = message;
    alert.alertStyle = NSAlertStyleWarning;
    [alert addButtonWithTitle:cancel];
    [alert addButtonWithTitle:accept];
    return [alert runModal] == NSAlertSecondButtonReturn;
}

- (NSString *)ask:(NSString *)title message:(NSString *)message defaultValue:(NSString *)defaultValue {
    NSTextField *field = [NSTextField textFieldWithString:defaultValue];
    field.frame = NSMakeRect(0, 0, 340, 25);
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = message;
    alert.accessoryView = field;
    [alert addButtonWithTitle:@"保存"];
    [alert addButtonWithTitle:@"返回"];
    if ([alert runModal] != NSAlertFirstButtonReturn) return nil;
    return [field.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

- (void)runLong:(NSString *)status arguments:(NSArray<NSString *> *)arguments completion:(void (^)(NSDictionary *))completion {
    self.statusLabel.stringValue = status;
    for (NSButton *button in self.actionButtons) button.enabled = NO;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSDictionary *result = [self runBridge:arguments];
        dispatch_async(dispatch_get_main_queue(), ^{
            for (NSButton *button in self.actionButtons) button.enabled = YES;
            self.statusLabel.stringValue = [result[@"ok"] boolValue] ? @"完成" : @"没有完成";
            completion(result);
        });
    });
}

- (void)importWord:(id)sender {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"选择要导入的 Word 文稿";
    panel.allowedContentTypes = @[[UTType typeWithIdentifier:@"org.openxmlformats.wordprocessingml.document"]];
    panel.allowsMultipleSelection = NO;
    panel.directoryURL = [NSURL fileURLWithPath:[self.rootPath stringByAppendingPathComponent:@"incoming"] isDirectory:YES];
    if ([panel runModal] != NSModalResponseOK || panel.URL == nil) return;

    NSDictionary *inferred = [self runBridge:@[@"infer", panel.URL.path]];
    if (![inferred[@"ok"] boolValue]) {
        [self showAlert:@"无法读取 Word 文稿" message:inferred[@"output"] critical:YES];
        return;
    }
    NSDictionary *info = [self fields:inferred[@"output"]];
    NSString *title = info[@"TITLE"] ?: panel.URL.URLByDeletingPathExtension.lastPathComponent;
    NSString *location = info[@"LOCATION"] ?: @"文章";
    NSString *articleURL = info[@"URL"] ?: @"/";

    NSAlert *choice = [[NSAlert alloc] init];
    choice.messageText = [NSString stringWithFormat:@"准备导入《%@》", title];
    choice.informativeText = [NSString stringWithFormat:@"归入：%@\n网址：%@\n\n请选择先保存为草稿，还是直接公开。", location, articleURL];
    [choice addButtonWithTitle:@"保存为草稿"];
    [choice addButtonWithTitle:@"直接公开"];
    [choice addButtonWithTitle:@"返回"];
    NSModalResponse answer = [choice runModal];
    if (answer == NSAlertThirdButtonReturn) return;
    NSString *publicFlag = answer == NSAlertSecondButtonReturn ? @"1" : @"0";
    NSString *replaceFlag = @"0";
    if ([info[@"EXISTING"] isEqualToString:@"True"]) {
        if (![self confirm:@"这篇文章已经存在"
                   message:@"系统会先自动备份旧稿，再用当前 Word 文稿替换。旧稿不会丢失。"
                    accept:@"备份并替换" cancel:@"保留旧稿"]) return;
        replaceFlag = @"1";
    }

    [self runLong:@"正在导入并处理图片……"
        arguments:@[@"import", panel.URL.path, publicFlag, replaceFlag]
       completion:^(NSDictionary *result) {
        if (![result[@"ok"] boolValue]) {
            [self showAlert:@"Word 导入没有完成" message:result[@"output"] critical:YES];
            return;
        }
        NSDictionary *preview = [self runBridge:@[@"preview", articleURL]];
        NSString *urlText = [self fields:preview[@"output"]][@"URL"];
        if ([preview[@"ok"] boolValue] && urlText.length) [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:urlText]];
        [self showAlert:@"导入完成" message:[NSString stringWithFormat:@"《%@》已生成，并已打开本地预览。", title] critical:NO];
    }];
}

- (void)previewSite:(id)sender {
    [self runLong:@"正在启动本地预览……" arguments:@[@"preview", @"/"] completion:^(NSDictionary *result) {
        NSString *urlText = [self fields:result[@"output"]][@"URL"];
        if (![result[@"ok"] boolValue] || !urlText.length) {
            [self showAlert:@"预览没有启动" message:result[@"output"] critical:YES];
            return;
        }
        [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:urlText]];
    }];
}

- (void)backupSite:(id)sender {
    [self runLong:@"正在备份网站和文章……" arguments:@[@"backup"] completion:^(NSDictionary *result) {
        [self showAlert:[result[@"ok"] boolValue] ? @"备份完成" : @"备份没有完成"
                message:result[@"output"] critical:![result[@"ok"] boolValue]];
    }];
}

- (void)publishSite:(id)sender {
    NSDictionary *summary = [self runBridge:@[@"summary"]];
    if (![summary[@"ok"] boolValue]) {
        [self showAlert:@"无法生成发布摘要" message:summary[@"output"] critical:YES];
        return;
    }
    if (![self confirm:@"发布前检查" message:summary[@"output"] accept:@"继续发布" cancel:@"返回检查"]) return;

    NSDictionary *settingsResult = [self runBridge:@[@"get-settings"]];
    NSMutableDictionary *settings = [[self fields:settingsResult[@"output"]] mutableCopy];
    if (![settingsResult[@"ok"] boolValue] || !settings[@"SSH"] || !settings[@"DOMAIN"]) {
        NSString *ssh = [self ask:@"服务器地址" message:@"请填写自己的服务器。" defaultValue:@"user@example.com"];
        if (!ssh) return;
        NSString *domain = [self ask:@"文章网站域名" message:@"填写读者访问文章网站使用的域名。" defaultValue:@"example.com"];
        if (!domain) return;
        NSDictionary *saved = [self runBridge:@[@"save-settings", ssh, domain]];
        if (![saved[@"ok"] boolValue]) {
            [self showAlert:@"发布设置没有保存" message:saved[@"output"] critical:YES];
            return;
        }
        settings = [@{@"SSH": ssh, @"DOMAIN": domain} mutableCopy];
    }
    NSString *domain = settings[@"DOMAIN"];
    if (![self confirm:@"确认发布到正式网站？"
                message:[NSString stringWithFormat:@"目标网站：%@\n\n系统会先构建和检查；失败时不会替换当前网站。", domain]
                 accept:@"确认发布" cancel:@"暂不发布"]) return;
    [self runLong:@"正在检查、备份并发布，请稍候……" arguments:@[@"publish"] completion:^(NSDictionary *result) {
        BOOL ok = [result[@"ok"] boolValue];
        [self showAlert:ok ? @"发布完成" : @"发布没有完成" message:result[@"output"] critical:!ok];
        if (ok) [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:[NSString stringWithFormat:@"https://%@/", domain]]];
    }];
}

- (void)openIncoming:(id)sender {
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:[self.rootPath stringByAppendingPathComponent:@"incoming"] isDirectory:YES]];
}

- (void)stopPreview:(id)sender {
    NSDictionary *result = [self runBridge:@[@"stop-preview"]];
    self.statusLabel.stringValue = result[@"output"];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        AuthorAppDelegate *delegate = [[AuthorAppDelegate alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}
