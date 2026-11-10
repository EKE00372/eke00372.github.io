# frozen_string_literal: true

require "fileutils"
require "tmpdir"
require "jekyll"

ENV["JEKYLL_ENV"] ||= "production"

project_root = File.expand_path("..", __dir__)
destination = File.expand_path(ARGV.fetch(0, "_site"), project_root)
# Only these generated directories may be cleaned by Jekyll.
allowed_destinations = ["_site", ".self/site"].map { |path| File.join(project_root, path) }
abort "Destination must be _site or .self/site." unless allowed_destinations.include?(destination)

cache_root = File.join(project_root, ".jekyll-cache")
FileUtils.mkdir_p(cache_root)

def build_site(source, destination, configs)
  config = Jekyll.configuration(
    "source" => source,
    "destination" => destination,
    "config" => configs,
    "trace" => true
  )
  Jekyll::Site.new(config).process
end

# Stage only the files intended for publication. Repository documents,
# deployment code and the other site's source never enter a site's build.
Dir.mktmpdir("eklib-", cache_root) do |stage|
  apex_source = File.join(stage, "apex")
  FileUtils.mkdir_p(apex_source)
  %w[index.html 404.html CNAME google0677e532d1629039.html].each do |name|
    FileUtils.cp(File.join(project_root, name), File.join(apex_source, name))
  end
  build_site(apex_source, destination, [File.join(project_root, "_config.yml")])

  %w[wow note].each do |site|
    site_source = File.join(stage, site)
    FileUtils.mkdir_p(site_source)
    %w[_includes _sass].each do |name|
      FileUtils.cp_r(File.join(project_root, "_shared", name), site_source)
    end
    Dir.children(File.join(project_root, "sites", site)).each do |name|
      FileUtils.cp_r(File.join(project_root, "sites", site, name), site_source)
    end
    build_site(
      site_source,
      File.join(destination, "_sites", site),
      [File.join(project_root, "_shared", "_config.yml"),
       File.join(project_root, "sites", site, "_config.yml")]
    )
  end
end

puts "Built apex, wow and note into #{destination}"
