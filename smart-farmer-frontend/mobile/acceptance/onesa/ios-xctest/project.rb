# Construct a simulator-only XCTest project outside the checkout. Its empty
# host is separate from the preinstalled Farmer app, so xcodebuild does not
# replace the application under test with a second build of Farmer.
require 'xcodeproj'
require 'fileutils'

root = File.expand_path(ARGV.fetch(0))
FileUtils.mkdir_p(root)
project_path = File.join(root, 'FarmerBrowser.xcodeproj')
project = Xcodeproj::Project.new(project_path)
host = project.new_target(:application, 'BrowserTestHost', :ios, '16.4')
tests = project.new_target(:ui_test_bundle, 'FarmerBrowserTests', :ios, '16.4')
tests.add_dependency(host)
[host, tests].each do |target|
  target.build_configurations.each do |config|
    config.build_settings.merge!(
      'GENERATE_INFOPLIST_FILE' => 'YES', 'SWIFT_VERSION' => '5.0',
      'PRODUCT_BUNDLE_IDENTIFIER' => "eu.onesa.farmer.acceptance.#{target.name.downcase}",
      'PRODUCT_NAME' => '$(TARGET_NAME)', 'SUPPORTED_PLATFORMS' => 'iphonesimulator',
      'TARGETED_DEVICE_FAMILY' => '1,2'
    )
    if target == tests
      config.build_settings['TEST_TARGET_NAME'] = host.name
    else
      config.build_settings['INFOPLIST_KEY_UILaunchScreen_Generation'] = 'YES'
    end
  end
end
File.write(File.join(root, 'Host.swift'), "import UIKit\n@main final class Host: UIResponder, UIApplicationDelegate {}\n")
FileUtils.cp(File.join(__dir__, 'PortalColdTests.swift'), root)
host.add_file_references([project.main_group.new_file('Host.swift')])
tests.add_file_references([project.main_group.new_file('PortalColdTests.swift')])
project.root_object.attributes['TargetAttributes'] = { tests.uuid => { 'TestTargetID' => host.uuid } }
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(host, tests, launch_target: true)
scheme.save_as(project_path, 'FarmerBrowser')
