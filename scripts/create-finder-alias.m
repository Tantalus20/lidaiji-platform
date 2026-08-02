#import <Foundation/Foundation.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) {
            fprintf(stderr, "用法：create-finder-alias 目标应用 别名路径\n");
            return 2;
        }
        NSString *targetPath = [NSString stringWithUTF8String:argv[1]];
        NSString *aliasPath = [NSString stringWithUTF8String:argv[2]];
        NSURL *targetURL = [NSURL fileURLWithPath:targetPath];
        NSURL *aliasURL = [NSURL fileURLWithPath:aliasPath];
        NSError *error = nil;
        NSData *bookmark = [targetURL bookmarkDataWithOptions:NSURLBookmarkCreationSuitableForBookmarkFile
                              includingResourceValuesForKeys:nil
                                               relativeToURL:nil
                                                       error:&error];
        if (!bookmark) {
            fprintf(stderr, "无法生成桌面别名：%s\n", error.localizedDescription.UTF8String);
            return 1;
        }
        if (![NSURL writeBookmarkData:bookmark
                                toURL:aliasURL
                              options:0
                                error:&error]) {
            fprintf(stderr, "无法写入桌面别名：%s\n", error.localizedDescription.UTF8String);
            return 1;
        }
    }
    return 0;
}
